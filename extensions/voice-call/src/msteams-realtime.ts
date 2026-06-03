/**
 * Microsoft Teams realtime voice bridge.
 *
 * When `realtime.enabled` is set for the msteams provider, a Teams call is wired
 * directly to a speech-to-speech realtime model (e.g. OpenAI / Azure OpenAI
 * Realtime) instead of the STT -> agent -> TTS pipeline. This is the low-latency
 * path: the model listens, thinks, and speaks in one streaming session.
 *
 * Audio crosses the existing msteams WebSocket as PCM 16 kHz, 16-bit mono. The
 * realtime model speaks PCM 16-bit mono at 24 kHz, so we resample on both legs:
 *   caller  16 kHz -> 24 kHz -> model
 *   model   24 kHz -> 16 kHz -> caller
 * The Windows worker reframes the downlink PCM into 20 ms / 640-byte frames, so
 * we can forward arbitrary-length chunks as a single `audio.frame`.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createRealtimeVoiceBridgeSession,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  resamplePcm,
  type RealtimeVoiceProviderConfig,
  type RealtimeVoiceProviderPlugin,
  type RealtimeVoiceTool,
} from "openclaw/plugin-sdk/realtime-voice";
import type { MsteamsLogger, MsteamsSession } from "./msteams-media-stream.js";

/** Teams bridge wire format. */
const MSTEAMS_SAMPLE_RATE_HZ = 16_000;
/** OpenAI/Azure realtime PCM format. */
const REALTIME_SAMPLE_RATE_HZ = 24_000;

export interface MsteamsRealtimeDeps {
  provider: RealtimeVoiceProviderPlugin;
  providerConfig: RealtimeVoiceProviderConfig;
  cfg?: OpenClawConfig;
  /** System instructions for the realtime model. */
  instructions?: string;
  /** Instruction used to open the call (model speaks first). */
  greetingInstructions?: string;
  /** Optional realtime tools (e.g. openclaw_agent_consult). */
  tools?: RealtimeVoiceTool[];
  /** Inbound-call policy applied before bridging (mirrors the streaming path). */
  inboundPolicy?: "disabled" | "allowlist" | "pairing" | "open";
  /** Allowlist of caller ids honored when inboundPolicy is "allowlist"/"pairing". */
  allowFrom?: string[];
  logger?: MsteamsLogger;
}

/** A single Teams call bridged to the realtime model. */
export interface MsteamsRealtimeCall {
  /** Forward one inbound PCM 16 kHz frame from the caller into the model. */
  pushAudio(pcm16k: Buffer): void;
  /** Tear down the realtime session. */
  close(): void;
}

/**
 * Create and connect a realtime bridge for one Teams call. Inbound caller audio
 * is fed via {@link MsteamsRealtimeCall.pushAudio}; model audio is sent back over
 * the provided {@link MsteamsSession} as `audio.frame` messages, and barge-in is
 * surfaced as `assistant.cancel` so the worker flushes its playback queue.
 */
export function createMsteamsRealtimeCall(params: {
  session: MsteamsSession;
  deps: MsteamsRealtimeDeps;
}): MsteamsRealtimeCall {
  const { session, deps } = params;
  const { logger } = deps;

  let outboundSeq = 0;
  let outboundTimestampMs = 0;
  let turnId = 0;
  let closed = false;

  const realtime = createRealtimeVoiceBridgeSession({
    provider: deps.provider,
    cfg: deps.cfg,
    providerConfig: deps.providerConfig,
    audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
    instructions: deps.instructions,
    initialGreetingInstructions: deps.greetingInstructions,
    triggerGreetingOnReady: Boolean(deps.greetingInstructions),
    autoRespondToAudio: true,
    interruptResponseOnInputAudio: true,
    tools: deps.tools,
    audioSink: {
      isOpen: () => !closed,
      sendAudio: (pcm24k: Buffer) => {
        if (closed || pcm24k.length === 0) {
          return;
        }
        const pcm16k = resamplePcm(pcm24k, REALTIME_SAMPLE_RATE_HZ, MSTEAMS_SAMPLE_RATE_HZ);
        session.send({
          type: "audio.frame",
          seq: outboundSeq,
          timestampMs: outboundTimestampMs,
          payloadBase64: pcm16k.toString("base64"),
        });
        outboundSeq += 1;
        // 16-bit mono: 2 bytes/sample.
        outboundTimestampMs += Math.round((pcm16k.length / 2 / MSTEAMS_SAMPLE_RATE_HZ) * 1000);
      },
      clearAudio: () => {
        // Barge-in: the model truncated its turn — tell the worker to flush the
        // audio it has already queued for playback so the caller isn't talked over.
        turnId += 1;
        session.send({ type: "assistant.cancel", turnId });
      },
    },
    onTranscript: (role, text, isFinal) => {
      if (isFinal && text.trim()) {
        logger?.debug?.(`MsteamsRealtime: ${role} transcript chars=${text.trim().length}`);
      }
    },
    onError: (error) => {
      logger?.warn(`MsteamsRealtime: bridge error — ${error.message}`);
    },
    onClose: () => {
      closed = true;
    },
  });

  void realtime.connect().catch((err: unknown) => {
    logger?.error(
      `MsteamsRealtime: connect failed — ${err instanceof Error ? err.message : String(err)}`,
    );
    // The model never came up; close the Teams session so the worker hangs up
    // cleanly instead of leaving the caller in silence.
    closed = true;
    try {
      session.close("realtime-unavailable");
    } catch {
      // best-effort teardown
    }
  });

  return {
    pushAudio: (pcm16k: Buffer) => {
      if (closed || pcm16k.length === 0) {
        return;
      }
      const pcm24k = resamplePcm(pcm16k, MSTEAMS_SAMPLE_RATE_HZ, REALTIME_SAMPLE_RATE_HZ);
      realtime.sendAudio(pcm24k);
    },
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      try {
        realtime.close();
      } catch {
        // best-effort teardown
      }
    },
  };
}
