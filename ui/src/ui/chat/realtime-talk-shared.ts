import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "../../../../src/talk/agent-consult-tool.js";
import { REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME } from "../../../../src/talk/describe-view-tool.js";
import type { TalkEvent } from "../../../../src/talk/talk-events.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../gateway.ts";

export type RealtimeTalkStatus = "idle" | "connecting" | "listening" | "thinking" | "error";
export type RealtimeTalkEvent = TalkEvent;

export type RealtimeTalkCallbacks = {
  onStatus?: (status: RealtimeTalkStatus, detail?: string) => void;
  onTranscript?: (entry: { role: "user" | "assistant"; text: string; final: boolean }) => void;
  onTalkEvent?: (event: RealtimeTalkEvent) => void;
  onVideoStream?: (stream: MediaStream | null) => void;
};

export type RealtimeTalkEventInput<TPayload = unknown> = {
  type: RealtimeTalkEvent["type"];
  payload?: TPayload;
  turnId?: string;
  captureId?: string;
  final?: boolean;
  callId?: string;
  itemId?: string;
  parentId?: string;
};

export type RealtimeTalkAudioContract = {
  inputEncoding: "pcm16" | "g711_ulaw";
  inputSampleRateHz: number;
  outputEncoding: "pcm16" | "g711_ulaw";
  outputSampleRateHz: number;
};

export type RealtimeTalkWebRtcSdpSessionResult = {
  provider: string;
  transport: "webrtc";
  clientSecret: string;
  offerUrl?: string;
  offerHeaders?: Record<string, string>;
  model?: string;
  voice?: string;
  expiresAt?: number;
  consultThinkingLevel?: string;
  consultFastMode?: boolean;
};

export type RealtimeTalkJsonPcmWebSocketSessionResult = {
  provider: string;
  transport: "provider-websocket";
  protocol: string;
  clientSecret: string;
  websocketUrl: string;
  audio: RealtimeTalkAudioContract;
  initialMessage?: unknown;
  model?: string;
  voice?: string;
  expiresAt?: number;
  consultThinkingLevel?: string;
  consultFastMode?: boolean;
};

export type RealtimeTalkGatewayRelaySessionResult = {
  provider: string;
  transport: "gateway-relay";
  relaySessionId: string;
  audio: RealtimeTalkAudioContract;
  model?: string;
  voice?: string;
  expiresAt?: number;
  consultThinkingLevel?: string;
  consultFastMode?: boolean;
};

export type RealtimeTalkManagedRoomSessionResult = {
  provider: string;
  transport: "managed-room";
  roomUrl: string;
  token?: string;
  model?: string;
  voice?: string;
  expiresAt?: number;
  consultThinkingLevel?: string;
  consultFastMode?: boolean;
};

export type RealtimeTalkSessionResult =
  | RealtimeTalkWebRtcSdpSessionResult
  | RealtimeTalkJsonPcmWebSocketSessionResult
  | RealtimeTalkGatewayRelaySessionResult
  | RealtimeTalkManagedRoomSessionResult;

export type RealtimeTalkTransport = {
  start(): Promise<void>;
  stop(): void;
};

export type RealtimeTalkTransportContext = {
  client: GatewayBrowserClient;
  sessionKey: string;
  callbacks: RealtimeTalkCallbacks;
  consultThinkingLevel?: string;
  consultFastMode?: boolean;
  videoEnabled?: boolean;
};

export function createRealtimeTalkEventEmitter(
  ctx: RealtimeTalkTransportContext,
  session: RealtimeTalkSessionResult,
): (input: RealtimeTalkEventInput) => void {
  let seq = 0;
  let turnSeq = 0;
  let activeTurnId: string | undefined;
  const sessionId = resolveRealtimeTalkEventSessionId(ctx, session);
  return (input) => {
    if (!ctx.callbacks.onTalkEvent) {
      return;
    }
    const turnId = resolveRealtimeTalkTurnId(input);
    seq += 1;
    ctx.callbacks.onTalkEvent({
      id: `${sessionId}:${seq}`,
      type: input.type,
      sessionId,
      turnId,
      captureId: input.captureId,
      seq,
      timestamp: new Date().toISOString(),
      mode: "realtime",
      transport: session.transport,
      brain: "agent-consult",
      provider: session.provider,
      final: input.final,
      callId: input.callId,
      itemId: input.itemId,
      parentId: input.parentId,
      payload: input.payload ?? null,
    });
    if (
      input.type === "turn.ended" ||
      input.type === "turn.cancelled" ||
      input.type === "session.replaced" ||
      input.type === "session.closed"
    ) {
      activeTurnId = undefined;
    }
  };

  function resolveRealtimeTalkTurnId(input: RealtimeTalkEventInput): string | undefined {
    if (input.type === "turn.started") {
      activeTurnId = input.turnId ?? activeTurnId ?? `turn-${++turnSeq}`;
      return activeTurnId;
    }
    if (!isTurnScopedTalkEvent(input.type)) {
      return input.turnId;
    }
    activeTurnId = input.turnId ?? activeTurnId ?? `turn-${++turnSeq}`;
    return activeTurnId;
  }
}

function isTurnScopedTalkEvent(type: RealtimeTalkEvent["type"]): boolean {
  return (
    type === "turn.ended" ||
    type === "turn.cancelled" ||
    type.startsWith("input.audio.") ||
    type.startsWith("transcript.") ||
    type.startsWith("output.") ||
    type.startsWith("tool.")
  );
}

function resolveRealtimeTalkEventSessionId(
  ctx: RealtimeTalkTransportContext,
  session: RealtimeTalkSessionResult,
): string {
  const explicitSessionId = (session as { sessionId?: unknown }).sessionId;
  if (typeof explicitSessionId === "string" && explicitSessionId.trim()) {
    return explicitSessionId.trim();
  }
  if ("relaySessionId" in session && session.relaySessionId.trim()) {
    return session.relaySessionId;
  }
  return `${ctx.sessionKey}:${session.provider}:${session.transport}`;
}

type ChatPayload = {
  runId?: string;
  state?: string;
  errorMessage?: string;
  message?: unknown;
};

function extractTextFromMessage(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const record = message as Record<string, unknown>;
  if (typeof record.text === "string") {
    return record.text;
  }
  const content = Array.isArray(record.content) ? record.content : [];
  const parts = content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      const entry = block as Record<string, unknown>;
      return entry.type === "text" && typeof entry.text === "string" ? entry.text : "";
    })
    .filter(Boolean);
  return parts.join("\n\n").trim();
}

function waitForChatResult(params: {
  client: GatewayBrowserClient;
  runId: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (params.signal?.aborted) {
      reject(new DOMException("OpenClaw tool call aborted", "AbortError"));
      return;
    }
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("OpenClaw tool call timed out"));
    }, params.timeoutMs);
    const onAbort = () => {
      cleanup();
      reject(new DOMException("OpenClaw tool call aborted", "AbortError"));
    };
    params.signal?.addEventListener("abort", onAbort, { once: true });
    let unsubscribe: () => void = () => undefined;
    unsubscribe = params.client.addEventListener((evt: GatewayEventFrame) => {
      if (evt.event !== "chat") {
        return;
      }
      const payload = evt.payload as ChatPayload | undefined;
      if (!payload || payload.runId !== params.runId) {
        return;
      }
      if (payload.state === "final") {
        cleanup();
        resolve(extractTextFromMessage(payload.message) || "OpenClaw finished with no text.");
      } else if (payload.state === "aborted") {
        cleanup();
        reject(
          new DOMException(payload.errorMessage ?? "OpenClaw tool call aborted", "AbortError"),
        );
      } else if (payload.state === "error") {
        cleanup();
        reject(new Error(payload.errorMessage ?? "OpenClaw tool call failed"));
      }
    });
    function cleanup() {
      window.clearTimeout(timer);
      params.signal?.removeEventListener("abort", onAbort);
      unsubscribe();
    }
  });
}

export async function submitRealtimeTalkConsult(params: {
  ctx: RealtimeTalkTransportContext;
  args: unknown;
  submit: (callId: string, result: unknown) => void;
  callId: string;
  relaySessionId?: string;
  signal?: AbortSignal;
}): Promise<void> {
  const { ctx, callId, submit } = params;
  ctx.callbacks.onStatus?.("thinking");
  let runId: string | undefined;
  let aborted = false;
  const abortRun = () => {
    aborted = true;
    if (runId) {
      void ctx.client.request("chat.abort", { sessionKey: ctx.sessionKey, runId });
    }
  };
  if (params.signal?.aborted) {
    return;
  }
  params.signal?.addEventListener("abort", abortRun, { once: true });
  try {
    const args =
      typeof params.args === "string" ? JSON.parse(params.args || "{}") : (params.args ?? {});
    const response = await ctx.client.request<{ runId?: string; idempotencyKey?: string }>(
      "talk.client.toolCall",
      {
        sessionKey: ctx.sessionKey,
        callId,
        name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
        args,
        ...(params.relaySessionId ? { relaySessionId: params.relaySessionId } : {}),
      },
    );
    runId = response.runId ?? response.idempotencyKey;
    if (!runId) {
      throw new Error("OpenClaw realtime tool call did not return a run id");
    }
    if (params.signal?.aborted) {
      abortRun();
      return;
    }
    const result = await waitForChatResult({
      client: ctx.client,
      runId,
      timeoutMs: 120_000,
      signal: params.signal,
    });
    submit(callId, { result });
  } catch (error) {
    if (aborted || params.signal?.aborted || isAbortError(error)) {
      return;
    }
    submit(callId, {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    params.signal?.removeEventListener("abort", abortRun);
    if (!aborted && !params.signal?.aborted) {
      ctx.callbacks.onStatus?.("listening");
    }
  }
}

function isAbortError(error: unknown): boolean {
  return (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "AbortError"
  );
}

async function captureFrameFromVideoStream(
  stream: MediaStream | null,
): Promise<string | undefined> {
  if (!stream) {
    return undefined;
  }
  try {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("video play timeout")), 5000);
      const done = (fn: () => void) => () => {
        clearTimeout(timeout);
        fn();
      };
      video.addEventListener("canplay", done(resolve), { once: true });
      video.addEventListener(
        "error",
        done(() => reject(new Error("video error"))),
        { once: true },
      );
      video.play().catch(done(reject));
    });
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("canvas 2d context unavailable");
    }
    ctx.drawImage(video, 0, 0);
    video.pause();
    video.srcObject = null;
    const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
    return dataUrl.replace(/^data:image\/jpeg;base64,/, "");
  } catch {
    return undefined;
  }
}

export async function captureCurrentFrameAsBase64(): Promise<string | undefined> {
  let stream: MediaStream | undefined;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true });
    return await captureFrameFromVideoStream(stream);
  } catch {
    return undefined;
  } finally {
    stream?.getTracks().forEach((t) => t.stop());
  }
}

export { captureFrameFromVideoStream };

export { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME, REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME };
