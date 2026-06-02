import { MsteamsMediaStream, type MsteamsLogger } from "../msteams-media-stream.js";
import type {
  GetCallStatusInput,
  GetCallStatusResult,
  HangupCallInput,
  InitiateCallInput,
  InitiateCallResult,
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

/**
 * Microsoft Teams voice-call provider (Sprint 2.0 scaffolding).
 *
 * Unlike Twilio/Telnyx/Plivo, Teams calls do not arrive on the voice-call
 * webhook plane. The Windows-side worker (AzureBot) owns the Graph calling
 * notification endpoint and opens a WebSocket to OpenClaw when a call is
 * answered. This provider therefore stubs the webhook-driven lifecycle; the
 * real transport lives in `MsteamsMediaStream`.
 *
 * Phase 2.0 scope: all methods are stubs. Later tasks fill them in:
 * - playTts:                 task #16 (OpenClaw 2.2)
 * - startListening/stopListening: task #13 (OpenClaw 2.1)
 * - hangupCall:              task #11 verification onwards
 * - initiateCall:            deferred past Sprint 2 (outbound dialing)
 */
export class MsteamsProvider implements VoiceCallProvider {
  readonly name = "msteams" as const;

  // Bound only when port + path + sharedSecret are all provided. Without it
  // the provider is still usable for typecheck / runtime construction, but the
  // WebSocket server never listens — useful for unit tests and disabled-mode.
  private readonly mediaStream?: MsteamsMediaStream;

  constructor(options: MsteamsProviderOptions) {
    const { port, path, sharedSecret, logger } = options;
    if (port !== undefined && path && sharedSecret) {
      this.mediaStream = new MsteamsMediaStream({
        port,
        path,
        sharedSecret,
        logger,
        onSessionStart: (session) => {
          const callerId = session.caller.aadId ?? "(none)";
          logger?.info(
            `MsteamsProvider: session.start callId=${session.callId} threadId=${session.threadId} caller.aadId=${callerId}`,
          );
        },
        onSessionEnd: (info) => {
          logger?.info(`MsteamsProvider: session.end callId=${info.callId} reason=${info.reason}`);
        },
      });
      // Fire-and-forget; bind failures are surfaced via logger.error so a
      // misconfigured port does not crash the entire voice-call runtime.
      void this.mediaStream.start().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logger?.error(`MsteamsProvider: failed to start media stream: ${message}`);
      });
    } else {
      logger?.warn(
        "MsteamsProvider: msteams.port / msteams.path / msteams.sharedSecret not all set; WebSocket server not started",
      );
    }
  }

  /**
   * Stop the underlying WebSocket server. Should be called from the voice-call
   * runtime's teardown path. No-op if the provider was constructed without a
   * full configuration.
   */
  async stop(): Promise<void> {
    await this.mediaStream?.stop();
  }

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

  async hangupCall(_input: HangupCallInput): Promise<void> {
    // Phase 2.x will send AssistantCancel and close the WS for the call.
  }

  async playTts(_input: PlayTtsInput): Promise<void> {
    // Task #16 will synthesize via the configured TTS provider and stream
    // audio frames back over the WS to the worker.
  }

  async startListening(_input: StartListeningInput): Promise<void> {
    // Task #13 will begin forwarding worker-supplied audio frames to the
    // configured realtime-transcription provider.
  }

  async stopListening(_input: StopListeningInput): Promise<void> {
    // Task #13 will stop forwarding audio frames. WS stays open.
  }

  async getCallStatus(_input: GetCallStatusInput): Promise<GetCallStatusResult> {
    // Without webhook lifecycle, we cannot reliably probe Teams call status
    // from this side. Return non-terminal; the manager's timer-based fallback
    // handles cleanup of stale entries.
    return { status: "in-progress", isTerminal: false };
  }
}
