import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MsteamsSession } from "./msteams-media-stream.js";
import { createMsteamsRealtimeCall, type MsteamsRealtimeDeps } from "./msteams-realtime.js";

// Shared, hoisted handles so the vi.mock factory can reference them.
const { fakeBridge, bridgeCapture } = vi.hoisted(() => ({
  fakeBridge: {
    connect: vi.fn(async () => {}),
    sendAudio: vi.fn(),
    close: vi.fn(),
  },
  bridgeCapture: { params: undefined as unknown as Record<string, unknown> },
}));

// Mock only the bridge factory; keep resamplePcm + format constants real so the
// resampling assertions exercise the actual conversion.
vi.mock("openclaw/plugin-sdk/realtime-voice", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/realtime-voice")>();
  return {
    ...actual,
    createRealtimeVoiceBridgeSession: vi.fn((params: Record<string, unknown>) => {
      bridgeCapture.params = params;
      return fakeBridge;
    }) as unknown as typeof actual.createRealtimeVoiceBridgeSession,
  };
});

function makeSession() {
  const sent: Array<Record<string, unknown>> = [];
  const session = {
    callId: "call-rt",
    threadId: "thread-rt",
    caller: { aadId: "aad-rt" },
    send: (m: unknown) => sent.push(m as Record<string, unknown>),
    close: vi.fn(),
  } as unknown as MsteamsSession;
  return { session, sent };
}

const deps = {
  provider: {} as never,
  providerConfig: {} as never,
} as unknown as MsteamsRealtimeDeps;

function audioSink() {
  return bridgeCapture.params.audioSink as {
    isOpen: () => boolean;
    sendAudio: (pcm: Buffer) => void;
    clearAudio: () => void;
  };
}

describe("createMsteamsRealtimeCall", () => {
  beforeEach(() => {
    bridgeCapture.params = undefined as unknown as Record<string, unknown>;
    fakeBridge.connect.mockClear();
    fakeBridge.sendAudio.mockClear();
    fakeBridge.close.mockClear();
  });

  it("connects the realtime bridge", () => {
    const { session } = makeSession();
    createMsteamsRealtimeCall({ session, deps });
    expect(fakeBridge.connect).toHaveBeenCalledTimes(1);
  });

  it("forwards model audio to the worker as a resampled audio.frame (24k -> 16k)", () => {
    const { session, sent } = makeSession();
    createMsteamsRealtimeCall({ session, deps });
    const pcm24k = Buffer.alloc(480 * 2, 1); // 20 ms @ 24 kHz, 16-bit mono
    audioSink().sendAudio(pcm24k);

    const frames = sent.filter((m) => m.type === "audio.frame");
    expect(frames).toHaveLength(1);
    const decoded = Buffer.from(frames[0]?.payloadBase64 as string, "base64");
    expect(decoded.length).toBeGreaterThan(0);
    expect(decoded.length).toBeLessThan(pcm24k.length); // downsampled
  });

  it("emits assistant.cancel on barge-in (clearAudio)", () => {
    const { session, sent } = makeSession();
    createMsteamsRealtimeCall({ session, deps });
    audioSink().clearAudio();
    expect(sent.filter((m) => m.type === "assistant.cancel")).toHaveLength(1);
  });

  it("resamples and forwards caller audio via pushAudio (16k -> 24k)", () => {
    const { session } = makeSession();
    const call = createMsteamsRealtimeCall({ session, deps });
    const pcm16k = Buffer.alloc(320 * 2, 1); // 20 ms @ 16 kHz, 16-bit mono
    call.pushAudio(pcm16k);

    expect(fakeBridge.sendAudio).toHaveBeenCalledTimes(1);
    const forwarded = fakeBridge.sendAudio.mock.calls[0]?.[0] as Buffer;
    expect(forwarded.length).toBeGreaterThan(pcm16k.length); // upsampled
  });

  it("drops audio after close and tears down the bridge", () => {
    const { session } = makeSession();
    const call = createMsteamsRealtimeCall({ session, deps });
    call.close();
    expect(fakeBridge.close).toHaveBeenCalledTimes(1);

    call.pushAudio(Buffer.alloc(640, 1));
    // Only the initial connect-time call counts; nothing forwarded after close.
    expect(fakeBridge.sendAudio).not.toHaveBeenCalled();
  });
});
