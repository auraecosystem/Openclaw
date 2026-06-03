/**
 * MsteamsMediaStream
 *
 * WebSocket server that accepts connections from an external Windows-side Teams
 * bridge worker and relays Microsoft Teams call audio in both directions. One
 * connection per Teams call, keyed by callId in the URL path.
 *
 * Responsibilities:
 * - HTTP upgrade with HMAC-SHA256 verification of timestamp + callId, plus a
 *   replay window on the timestamp.
 * - Session lifecycle messages (session.start / session.end) parsed and emitted
 *   via callbacks for the host to wire into voice-call's session machinery.
 * - Inbound audio frames surfaced via `onAudioFrame` for the host to forward to
 *   the realtime-transcription provider.
 * - Outbound `send` and `close` exposed on the SessionStart callback so the host
 *   can push synthesized TTS audio and control messages back to the worker.
 */

import crypto from "node:crypto";
import http from "node:http";
import type { Duplex } from "node:stream";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import { z } from "zod";

const SessionStartSchema = z.object({
  type: z.literal("session.start"),
  callId: z.string().min(1),
  threadId: z.string().min(1),
  caller: z.object({
    aadId: z.string().nullable().optional(),
    displayName: z.string().nullable().optional(),
    tenantId: z.string().nullable().optional(),
  }),
});

const SessionEndSchema = z.object({
  type: z.literal("session.end"),
  reason: z.string(),
});

const AudioFrameSchema = z.object({
  type: z.literal("audio.frame"),
  seq: z.number().int().nonnegative(),
  timestampMs: z.number().int().nonnegative(),
  payloadBase64: z.string(),
});

const PingSchema = z.object({
  type: z.literal("ping"),
  ts: z.number().int().nonnegative(),
});

const InboundMessageSchema = z.discriminatedUnion("type", [
  SessionStartSchema,
  SessionEndSchema,
  AudioFrameSchema,
  PingSchema,
]);

type InboundMessage = z.infer<typeof InboundMessageSchema>;

export interface MsteamsLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug?(message: string): void;
}

export interface MsteamsSession {
  callId: string;
  threadId: string;
  caller: {
    aadId?: string | null;
    displayName?: string | null;
    tenantId?: string | null;
  };
  /** Push a JSON-serializable message back to the worker. No-op if the socket has closed. */
  send: (message: unknown) => void;
  /** Close the WebSocket gracefully with the given reason text. */
  close: (reason: string) => void;
}

export interface MsteamsMediaStreamConfig {
  port: number;
  /**
   * Interface address to bind the WebSocket server to. Defaults to the loopback
   * interface (127.0.0.1) so the bridge is not exposed on all interfaces.
   */
  bindAddress?: string;
  path: string;
  sharedSecret: string;
  /**
   * Reject upgrades whose timestamp is more than this many ms off from the
   * server clock. Mitigates replay. Default 60_000 (60 seconds).
   */
  hmacWindowMs?: number;
  logger?: MsteamsLogger;
  onSessionStart?: (session: MsteamsSession) => void;
  onSessionEnd?: (info: { callId: string; reason: string }) => void;
  onAudioFrame?: (info: {
    callId: string;
    seq: number;
    timestampMs: number;
    payload: Buffer;
  }) => void;
}

const DEFAULT_HMAC_WINDOW_MS = 60_000;

/**
 * Bind to loopback by default. The Teams bridge worker typically runs on the
 * same host (or reaches OpenClaw over a private/VPN interface the operator names
 * explicitly via `bindAddress`); binding all interfaces would expose the audio
 * transport to untrusted networks.
 */
const DEFAULT_BIND_ADDRESS = "127.0.0.1";

/**
 * Hard cap on a single inbound WebSocket frame. Legitimate messages are small
 * JSON envelopes — control messages plus one base64-encoded PCM audio frame,
 * well under 1 KB. Bounding the payload rejects oversized frames before they
 * reach JSON parsing, mitigating memory-exhaustion from unauthenticated peers.
 */
const MAX_INBOUND_PAYLOAD_BYTES = 64 * 1024;

export class MsteamsMediaStream {
  private readonly config: MsteamsMediaStreamConfig;
  private readonly hmacWindowMs: number;
  private readonly sessions = new Map<string, WebSocket>();
  private server?: http.Server;
  private wss?: WebSocketServer;

  constructor(config: MsteamsMediaStreamConfig) {
    this.config = config;
    this.hmacWindowMs = config.hmacWindowMs ?? DEFAULT_HMAC_WINDOW_MS;
  }

  async start(): Promise<void> {
    if (this.server) {
      throw new Error("MsteamsMediaStream is already started");
    }

    const server = http.createServer();
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INBOUND_PAYLOAD_BYTES });

    server.on("upgrade", (request, socket, head) => {
      this.handleUpgrade(request, socket, head, wss);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.config.port, this.config.bindAddress ?? DEFAULT_BIND_ADDRESS);
    });

    this.server = server;
    this.wss = wss;
    this.config.logger?.info(
      `MsteamsMediaStream listening host=${this.config.bindAddress ?? DEFAULT_BIND_ADDRESS} port=${this.config.port} path=${this.config.path}`,
    );
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    for (const ws of this.sessions.values()) {
      try {
        ws.close(1001, "shutdown");
      } catch {
        // best-effort close
      }
    }
    this.sessions.clear();

    this.wss?.close();
    await new Promise<void>((resolve) => {
      // server is non-null because we early-returned above; cast is for ts narrowing
      const s = this.server as http.Server;
      s.close(() => resolve());
    });

    this.server = undefined;
    this.wss = undefined;
    this.config.logger?.info("MsteamsMediaStream stopped");
  }

  /** Number of currently open sessions. Exposed for tests + telemetry. */
  get sessionCount(): number {
    return this.sessions.size;
  }

  private handleUpgrade(
    request: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    wss: WebSocketServer,
  ): void {
    const url = new URL(request.url ?? "", "http://localhost");

    if (!url.pathname.startsWith(this.config.path)) {
      this.rejectUpgrade(socket, 404, "Not Found");
      return;
    }

    const callId = url.pathname.slice(this.config.path.length).replace(/^\//, "");
    if (!callId) {
      this.rejectUpgrade(socket, 400, "Bad Request (missing callId)");
      return;
    }

    const timestamp = request.headers["x-azurebot-timestamp"];
    const signature = request.headers["x-azurebot-signature"];
    if (typeof timestamp !== "string" || typeof signature !== "string") {
      this.config.logger?.warn(
        `MsteamsMediaStream: rejecting upgrade for ${callId} — missing HMAC headers`,
      );
      this.rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }

    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > this.hmacWindowMs) {
      this.config.logger?.warn(
        `MsteamsMediaStream: rejecting upgrade for ${callId} — timestamp out of window`,
      );
      this.rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }

    const expected = crypto
      .createHmac("sha256", this.config.sharedSecret)
      .update(`${ts}.${callId}`)
      .digest("hex");
    if (!safeEqualSecret(signature, expected)) {
      this.config.logger?.warn(
        `MsteamsMediaStream: rejecting upgrade for ${callId} — bad signature`,
      );
      this.rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      this.attachSession(callId, ws);
    });
  }

  private attachSession(callId: string, ws: WebSocket): void {
    if (this.sessions.has(callId)) {
      // Same callId already connected — close the new one to avoid clobbering.
      try {
        ws.close(1008, "duplicate-callId");
      } catch {
        // ignore
      }
      this.config.logger?.warn(`MsteamsMediaStream: rejected duplicate connection for ${callId}`);
      return;
    }

    this.sessions.set(callId, ws);
    this.config.logger?.info(`MsteamsMediaStream: connection open ${callId}`);

    ws.on("message", (data) => this.handleMessage(callId, data));
    ws.on("close", () => {
      this.sessions.delete(callId);
      this.config.logger?.info(`MsteamsMediaStream: connection closed ${callId}`);
    });
    ws.on("error", (err) => {
      const message = err instanceof Error ? err.message : String(err);
      this.config.logger?.warn(`MsteamsMediaStream: ws error ${callId} — ${message}`);
    });
  }

  private handleMessage(callId: string, data: RawData): void {
    const text = rawDataToString(data);
    if (text === null) {
      return;
    }

    let parsed: InboundMessage;
    try {
      parsed = InboundMessageSchema.parse(JSON.parse(text));
    } catch (err) {
      this.config.logger?.warn(
        `MsteamsMediaStream: invalid message from ${callId}: ${(err as Error).message}`,
      );
      return;
    }

    switch (parsed.type) {
      case "session.start": {
        this.config.onSessionStart?.({
          callId: parsed.callId,
          threadId: parsed.threadId,
          caller: parsed.caller,
          send: (message) => this.sendTo(callId, message),
          close: (reason) => this.closeSession(callId, reason),
        });
        break;
      }
      case "session.end": {
        this.config.onSessionEnd?.({ callId, reason: parsed.reason });
        this.closeSession(callId, parsed.reason);
        break;
      }
      case "audio.frame": {
        this.config.onAudioFrame?.({
          callId,
          seq: parsed.seq,
          timestampMs: parsed.timestampMs,
          payload: Buffer.from(parsed.payloadBase64, "base64"),
        });
        break;
      }
      case "ping": {
        this.sendTo(callId, { type: "pong", ts: parsed.ts });
        break;
      }
    }
  }

  private sendTo(callId: string, message: unknown): void {
    const ws = this.sessions.get(callId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  private closeSession(callId: string, reason: string): void {
    const ws = this.sessions.get(callId);
    if (!ws) {
      return;
    }
    try {
      ws.close(1000, reason);
    } catch {
      // ignore
    }
    this.sessions.delete(callId);
  }

  private rejectUpgrade(socket: Duplex, code: number, reason: string): void {
    socket.write(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }
}

function rawDataToString(data: RawData): string | null {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  // ArrayBuffer fallback
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return null;
}
