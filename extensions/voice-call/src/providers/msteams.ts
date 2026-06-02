import { setTimeout as sleep } from "node:timers/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  RealtimeTranscriptionProviderConfig,
  RealtimeTranscriptionProviderPlugin,
  RealtimeTranscriptionSession,
} from "openclaw/plugin-sdk/realtime-transcription";
import { resolveVoiceCallEffectiveConfig, type VoiceCallConfig } from "../config.js";
import type { CoreAgentDeps, CoreConfig } from "../core-bridge.js";
import type { CallManager } from "../manager.js";
import {
  MsteamsMediaStream,
  type MsteamsLogger,
  type MsteamsSession,
} from "../msteams-media-stream.js";
import type { MsteamsTtsProvider } from "../msteams-tts.js";
import { generateVoiceResponse } from "../response-generator.js";
import { chunkAudio } from "../telephony-audio.js";
import type {
  EndReason,
  GetCallStatusInput,
  GetCallStatusResult,
  HangupCallInput,
  InitiateCallInput,
  InitiateCallResult,
  NormalizedEvent,
  PlayTtsInput,
  ProviderWebhookParseResult,
  StartListeningInput,
  StopListeningInput,
  WebhookContext,
  WebhookParseOptions,
  WebhookVerificationResult,
} from "../types.js";
import type { VoiceCallProvider } from "./base.js";

export interface MsteamsProviderOptions {
  port?: number;
  path?: string;
  sharedSecret?: string;
  logger?: MsteamsLogger;
}

/** Resolved realtime-transcription provider plus the config needed per session. */
interface MsteamsTranscriptionDeps {
  provider: RealtimeTranscriptionProviderPlugin;
  providerConfig: RealtimeTranscriptionProviderConfig;
  cfg?: OpenClawConfig;
}

/** Host dependencies needed to generate agent responses for a turn. */
interface MsteamsResponseRuntime {
  coreConfig: CoreConfig;
  agentRuntime: CoreAgentDeps;
  voiceConfig: VoiceCallConfig;
}

/** Per-call bridge state, keyed by the Teams callId (== providerCallId). */
interface MsteamsCallState {
  providerCallId: string;
  /** Internal CallManager call id (UUID) for this Teams call. */
  internalCallId: string;
  session: MsteamsSession;
  sttSession: RealtimeTranscriptionSession;
  /** Aborts the in-flight TTS playback (barge-in / hangup). */
  ttsAbort: AbortController | null;
  /** Monotonic outbound audio.frame sequence number for this call. */
  outboundSeq: number;
  /** Monotonic outbound presentation timestamp (ms) for this call. */
  outboundTimestampMs: number;
  /** Current assistant turn id (used for assistant.cancel on barge-in). */
  turnId: number;
}

/** PCM 16 kHz, 16-bit mono — the wire format both directions of the Teams bridge. */
const MSTEAMS_SAMPLE_RATE_HZ = 16_000;
const FRAME_DURATION_MS = 20;
const BYTES_PER_SAMPLE = 2;
/** 16000 Hz * 0.02 s * 2 bytes = 640 bytes per 20 ms mono frame. */
const FRAME_BYTES = (MSTEAMS_SAMPLE_RATE_HZ / 1000) * FRAME_DURATION_MS * BYTES_PER_SAMPLE;

/**
 * Microsoft Teams voice-call provider.
 *
 * Unlike Twilio/Telnyx/Plivo, Teams calls do not arrive on the voice-call
 * webhook plane. The Windows-side worker (AzureBot) owns the Graph calling
 * notification endpoint and opens a per-call WebSocket to OpenClaw when a call
 * is answered. The real transport lives in `MsteamsMediaStream`; this provider
 * wires that transport into the existing voice-call machinery (CallManager,
 * realtime transcription, response generation, telephony TTS), mirroring the
 * streaming Twilio provider but speaking PCM 16 kHz instead of mu-law 8 kHz.
 */
export class MsteamsProvider implements VoiceCallProvider {
  readonly name = "msteams" as const;

  private readonly logger?: MsteamsLogger;

  // Bound only when port + path + sharedSecret are all provided. Without it
  // the provider is still usable for typecheck / runtime construction, but the
  // WebSocket server never listens — useful for unit tests and disabled-mode.
  private readonly mediaStream?: MsteamsMediaStream;

  private manager: CallManager | null = null;
  private transcription: MsteamsTranscriptionDeps | null = null;
  private ttsProvider: MsteamsTtsProvider | null = null;
  private responseRuntime: MsteamsResponseRuntime | null = null;

  private readonly calls = new Map<string, MsteamsCallState>();

  constructor(options: MsteamsProviderOptions) {
    const { port, path, sharedSecret, logger } = options;
    this.logger = logger;
    if (port !== undefined && path && sharedSecret) {
      this.mediaStream = new MsteamsMediaStream({
        port,
        path,
        sharedSecret,
        logger,
        onSessionStart: (session) => this.handleSessionStart(session),
        onSessionEnd: (info) => this.handleSessionEnd(info),
        onAudioFrame: (frame) => this.handleAudioFrame(frame),
      });
      // Fire-and-forget; bind failures are surfaced via logger.error so a
      // misconfigured port does not crash the entire voice-call runtime.
      void this.mediaStream.start().catch((err: unknown) => {
        logger?.error(`MsteamsProvider: failed to start media stream: ${describeError(err)}`);
      });
    } else {
      logger?.warn(
        "MsteamsProvider: msteams.port / msteams.path / msteams.sharedSecret not all set; WebSocket server not started",
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Dependency injection (called by the runtime, mirroring Twilio's setters).
  // ---------------------------------------------------------------------------

  setCallManager(manager: CallManager): void {
    this.manager = manager;
  }

  setTranscriptionProvider(
    provider: RealtimeTranscriptionProviderPlugin,
    providerConfig: RealtimeTranscriptionProviderConfig,
    cfg?: OpenClawConfig,
  ): void {
    this.transcription = { provider, providerConfig, cfg };
  }

  setTtsProvider(provider: MsteamsTtsProvider): void {
    this.ttsProvider = provider;
  }

  setResponseRuntime(runtime: MsteamsResponseRuntime): void {
    this.responseRuntime = runtime;
  }

  /**
   * Stop the underlying WebSocket server. Called from the voice-call runtime's
   * teardown path. No-op if the provider was constructed without a full config.
   */
  async stop(): Promise<void> {
    for (const providerCallId of Array.from(this.calls.keys())) {
      this.teardownCall(providerCallId, { closeSession: true, reason: "shutdown" });
    }
    await this.mediaStream?.stop();
  }

  // ---------------------------------------------------------------------------
  // WebSocket lifecycle wiring.
  // ---------------------------------------------------------------------------

  private handleSessionStart(session: MsteamsSession): void {
    const providerCallId = session.callId;
    if (!this.manager || !this.transcription) {
      this.logger?.error(
        `MsteamsProvider: session.start for ${providerCallId} before dependencies were wired; closing`,
      );
      session.close("not-ready");
      return;
    }
    if (this.calls.has(providerCallId)) {
      this.logger?.warn(`MsteamsProvider: duplicate session.start for ${providerCallId}`);
      return;
    }

    const from = session.caller.aadId ?? "teams";
    const to = this.responseRuntime?.voiceConfig.fromNumber ?? "msteams";

    // Register the call with the manager. `call.initiated` creates the record
    // (subject to inbound policy); `call.answered` starts timers and triggers
    // the configured initial greeting via provider.playTts.
    this.manager.processEvent(
      this.buildEvent(providerCallId, { type: "call.initiated", from, to }),
    );
    const record = this.manager.getCallByProviderCallId(providerCallId);
    if (!record) {
      this.logger?.warn(
        `MsteamsProvider: call ${providerCallId} was not registered (rejected by inbound policy?); closing`,
      );
      session.close("rejected");
      return;
    }

    const sttSession = this.transcription.provider.createSession({
      cfg: this.transcription.cfg,
      providerConfig: this.transcription.providerConfig,
      onPartial: (partial) => {
        this.logger?.debug?.(`MsteamsProvider: partial ${providerCallId} chars=${partial.length}`);
      },
      onTranscript: (transcript) => this.handleTranscript(providerCallId, transcript),
      onSpeechStart: () => this.handleSpeechStart(providerCallId),
      onError: (error) => {
        this.logger?.warn(`MsteamsProvider: STT error ${providerCallId} — ${error.message}`);
      },
    });

    const state: MsteamsCallState = {
      providerCallId,
      internalCallId: record.callId,
      session,
      sttSession,
      ttsAbort: null,
      outboundSeq: 0,
      outboundTimestampMs: 0,
      turnId: 0,
    };
    // Register state BEFORE `call.answered` so the greeting's playTts can find it.
    this.calls.set(providerCallId, state);

    void sttSession.connect().catch((err: unknown) => {
      this.logger?.error(
        `MsteamsProvider: STT connect failed for ${providerCallId} — ${describeError(err)}`,
      );
    });

    this.manager.processEvent(this.buildEvent(providerCallId, { type: "call.answered", from, to }));
    this.logger?.info(
      `MsteamsProvider: session.start callId=${providerCallId} threadId=${session.threadId} caller.aadId=${from}`,
    );
  }

  private handleAudioFrame(frame: { callId: string; payload: Buffer }): void {
    const state = this.calls.get(frame.callId);
    if (!state) {
      return;
    }
    // PCM 16 kHz passes straight through (provider configured for pcm_16000).
    // Drop frames that arrive before the STT socket finishes connecting.
    if (!state.sttSession.isConnected()) {
      return;
    }
    state.sttSession.sendAudio(frame.payload);
  }

  private handleTranscript(providerCallId: string, transcript: string): void {
    const trimmed = transcript.trim();
    if (!trimmed) {
      return;
    }
    const state = this.calls.get(providerCallId);
    if (!state || !this.manager) {
      return;
    }
    this.manager.processEvent({
      id: `msteams-speech-${providerCallId}-${Date.now()}`,
      type: "call.speech",
      callId: state.internalCallId,
      providerCallId,
      timestamp: Date.now(),
      transcript: trimmed,
      isFinal: true,
    });
    void this.respond(state, trimmed).catch((err: unknown) => {
      this.logger?.warn(
        `MsteamsProvider: failed to respond on ${providerCallId} — ${describeError(err)}`,
      );
    });
  }

  /**
   * Generate an agent reply by composing the existing exported helpers
   * (`generateVoiceResponse` + `manager.speak`), rather than duplicating the
   * webhook's `handleInboundResponse`.
   */
  private async respond(state: MsteamsCallState, userMessage: string): Promise<void> {
    if (!this.manager || !this.responseRuntime) {
      return;
    }
    const call = this.manager.getCall(state.internalCallId);
    if (!call) {
      return;
    }
    const { coreConfig, agentRuntime, voiceConfig } = this.responseRuntime;
    const numberRouteKey =
      typeof call.metadata?.numberRouteKey === "string" ? call.metadata.numberRouteKey : call.to;
    const effectiveConfig = resolveVoiceCallEffectiveConfig(voiceConfig, numberRouteKey).config;

    const result = await generateVoiceResponse({
      voiceConfig: effectiveConfig,
      coreConfig,
      agentRuntime,
      callId: state.internalCallId,
      sessionKey: call.sessionKey,
      from: call.from,
      transcript: call.transcript,
      userMessage,
    });

    if (result.error) {
      this.logger?.warn(`MsteamsProvider: response generation error: ${result.error}`);
      return;
    }
    if (result.text) {
      await this.manager.speak(state.internalCallId, result.text);
    }
  }

  /** Barge-in: stop in-flight playback and tell the worker to flush its buffer. */
  private handleSpeechStart(providerCallId: string): void {
    const state = this.calls.get(providerCallId);
    if (!state) {
      return;
    }
    state.ttsAbort?.abort();
    state.ttsAbort = null;
    state.session.send({ type: "assistant.cancel", turnId: state.turnId });
  }

  private handleSessionEnd(info: { callId: string; reason: string }): void {
    const state = this.teardownCall(info.callId, { closeSession: false });
    if (!state || !this.manager) {
      return;
    }
    this.manager.processEvent({
      id: `msteams-ended-${info.callId}-${Date.now()}`,
      type: "call.ended",
      callId: state.internalCallId,
      providerCallId: info.callId,
      timestamp: Date.now(),
      reason: mapEndReason(info.reason),
    });
  }

  /** Abort playback, close the STT session, and drop per-call state. */
  private teardownCall(
    providerCallId: string,
    options: { closeSession: boolean; reason?: string },
  ): MsteamsCallState | undefined {
    const state = this.calls.get(providerCallId);
    if (!state) {
      return undefined;
    }
    this.calls.delete(providerCallId);
    state.ttsAbort?.abort();
    state.ttsAbort = null;
    try {
      state.sttSession.close();
    } catch (err) {
      this.logger?.warn(
        `MsteamsProvider: error closing STT for ${providerCallId} — ${describeError(err)}`,
      );
    }
    if (options.closeSession) {
      state.session.close(options.reason ?? "completed");
    }
    return state;
  }

  private buildEvent(
    providerCallId: string,
    fields: { type: "call.initiated" | "call.answered"; from: string; to: string },
  ): NormalizedEvent {
    return {
      id: `msteams-${fields.type}-${providerCallId}-${Date.now()}`,
      type: fields.type,
      callId: providerCallId,
      providerCallId,
      timestamp: Date.now(),
      direction: "inbound",
      from: fields.from,
      to: fields.to,
    };
  }

  // ---------------------------------------------------------------------------
  // VoiceCallProvider surface.
  // ---------------------------------------------------------------------------

  verifyWebhook(_ctx: WebhookContext): WebhookVerificationResult {
    // Teams does not use the voice-call webhook plane — accept by default so
    // the manager does not reject incoming traffic. Real auth lives on the
    // WebSocket upgrade (see `MsteamsMediaStream`).
    return { ok: true };
  }

  parseWebhookEvent(
    _ctx: WebhookContext,
    _options?: WebhookParseOptions,
  ): ProviderWebhookParseResult {
    // No webhook events to parse — the WS provides the lifecycle.
    return { events: [], statusCode: 204 };
  }

  async initiateCall(_input: InitiateCallInput): Promise<InitiateCallResult> {
    // Outbound calls (OpenClaw asking the worker to dial into a meeting)
    // were intentionally deferred past Sprint 2 — locked decision.
    throw new Error("MsteamsProvider.initiateCall is not supported in Sprint 2 (inbound-only)");
  }

  async hangupCall(input: HangupCallInput): Promise<void> {
    // Manager-initiated hangup: stop playback, send AssistantCancel-equivalent
    // close, and tear down. The manager finalizes the call record itself.
    this.teardownCall(input.providerCallId, { closeSession: true, reason: input.reason });
  }

  async playTts(input: PlayTtsInput): Promise<void> {
    const state = this.calls.get(input.providerCallId);
    if (!state) {
      throw new Error(`MsteamsProvider.playTts: no active session for ${input.providerCallId}`);
    }
    if (!this.ttsProvider) {
      throw new Error("MsteamsProvider.playTts: TTS provider not configured");
    }

    // Supersede any in-flight playback for this call (e.g. rapid responses).
    state.ttsAbort?.abort();
    const abort = new AbortController();
    state.ttsAbort = abort;
    state.turnId += 1;

    // msteams-tts.ts synthesizes and resamples to PCM 16 kHz mono.
    const pcm16k = await this.ttsProvider.synthesizePcm16k(input.text);
    if (abort.signal.aborted) {
      return;
    }
    if (pcm16k.length === 0) {
      throw new Error("MsteamsProvider.playTts: TTS produced no audio");
    }

    await this.streamPcmFrames(state, pcm16k, abort.signal);

    if (state.ttsAbort === abort) {
      state.ttsAbort = null;
    }
  }

  /**
   * Chunk PCM into 20 ms / 640-byte frames and send them to the worker with
   * drift-corrected pacing, mirroring Twilio's `playTtsViaStream`. Uses an
   * absolute clock so cumulative scheduling jitter does not accumulate.
   */
  private async streamPcmFrames(
    state: MsteamsCallState,
    pcm: Buffer,
    signal: AbortSignal,
  ): Promise<void> {
    let nextFrameDueAt = Date.now() + FRAME_DURATION_MS;
    for (const frame of chunkAudio(pcm, FRAME_BYTES)) {
      if (signal.aborted) {
        return;
      }
      state.session.send({
        type: "audio.frame",
        seq: state.outboundSeq,
        timestampMs: state.outboundTimestampMs,
        payloadBase64: frame.toString("base64"),
      });
      state.outboundSeq += 1;
      state.outboundTimestampMs += FRAME_DURATION_MS;

      const waitMs = nextFrameDueAt - Date.now();
      if (waitMs > 0) {
        await sleep(waitMs);
      }
      nextFrameDueAt += FRAME_DURATION_MS;
    }
  }

  async startListening(_input: StartListeningInput): Promise<void> {
    // No-op: caller audio is already streaming over the WS into the STT session
    // for the lifetime of the call.
  }

  async stopListening(_input: StopListeningInput): Promise<void> {
    // No-op: the WS keeps streaming; there is no per-turn listen gate.
  }

  async getCallStatus(input: GetCallStatusInput): Promise<GetCallStatusResult> {
    // Status is driven by the WS lifecycle, not by webhook polling. Report
    // active while a session exists; otherwise treat as terminal so the
    // manager can reap stale persisted entries on restart.
    if (this.calls.has(input.providerCallId)) {
      return { status: "in-progress", isTerminal: false };
    }
    return { status: "completed", isTerminal: true };
  }
}

function mapEndReason(reason: string): EndReason {
  const normalized = reason.toLowerCase();
  if (normalized.includes("timeout")) {
    return "timeout";
  }
  if (normalized.includes("error") || normalized.includes("fail")) {
    return "error";
  }
  // Worker-driven session.end is a caller hangup in the common case.
  return "hangup-user";
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
