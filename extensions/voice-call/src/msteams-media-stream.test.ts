import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { MsteamsMediaStream, type MsteamsSession } from "./msteams-media-stream.js";

const SECRET = "test-shared-secret";
const PATH = "/voice/msteams/stream";

function signHmac(secret: string, ts: number, callId: string): string {
  return crypto.createHmac("sha256", secret).update(`${ts}.${callId}`).digest("hex");
}

/** Pick a port unlikely to collide. Range 31000-39999. */
function randomPort(): number {
  return 31000 + Math.floor(Math.random() * 9000);
}

async function startServer(opts: {
  port: number;
  onSessionStart?: (s: MsteamsSession) => void;
  onSessionEnd?: (info: { callId: string; reason: string }) => void;
  onAudioFrame?: (info: {
    callId: string;
    seq: number;
    timestampMs: number;
    payload: Buffer;
  }) => void;
}): Promise<MsteamsMediaStream> {
  const server = new MsteamsMediaStream({
    port: opts.port,
    path: PATH,
    sharedSecret: SECRET,
    onSessionStart: opts.onSessionStart,
    onSessionEnd: opts.onSessionEnd,
    onAudioFrame: opts.onAudioFrame,
  });
  await server.start();
  return server;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

describe("MsteamsMediaStream", () => {
  let server: MsteamsMediaStream | undefined;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = undefined;
    }
  });

  it("accepts a connection with valid HMAC + parses session.start", async () => {
    const port = randomPort();
    let receivedSession: MsteamsSession | undefined;
    server = await startServer({
      port,
      onSessionStart: (s) => {
        receivedSession = s;
      },
    });

    const callId = "call-abc";
    const ts = Date.now();
    const sig = signHmac(SECRET, ts, callId);

    const ws = new WebSocket(`ws://127.0.0.1:${port}${PATH}/${callId}`, {
      headers: {
        "x-azurebot-timestamp": String(ts),
        "x-azurebot-signature": sig,
      },
    });

    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    ws.send(
      JSON.stringify({
        type: "session.start",
        callId,
        threadId: "thread-xyz",
        caller: { aadId: "aad-1", displayName: "Alice", tenantId: "tenant-1" },
      }),
    );

    await waitFor(() => receivedSession !== undefined);

    expect(receivedSession?.callId).toBe(callId);
    expect(receivedSession?.threadId).toBe("thread-xyz");
    expect(receivedSession?.caller.displayName).toBe("Alice");
    expect(receivedSession?.caller.aadId).toBe("aad-1");
    expect(server.sessionCount).toBe(1);

    ws.close();
  });

  it("rejects upgrade with a bad HMAC signature", async () => {
    const port = randomPort();
    server = await startServer({ port });

    const callId = "call-bad-sig";
    const ws = new WebSocket(`ws://127.0.0.1:${port}${PATH}/${callId}`, {
      headers: {
        "x-azurebot-timestamp": String(Date.now()),
        "x-azurebot-signature": "deadbeef",
      },
    });

    const outcome = await new Promise<"unexpected-response" | "error" | "open">((resolve) => {
      ws.once("unexpected-response", (_req, res) => {
        expect(res.statusCode).toBe(401);
        resolve("unexpected-response");
      });
      ws.once("error", () => resolve("error"));
      ws.once("open", () => resolve("open"));
    });

    expect(outcome).not.toBe("open");
    expect(server.sessionCount).toBe(0);
  });

  it("rejects upgrade when timestamp is far outside the HMAC window", async () => {
    const port = randomPort();
    server = await startServer({ port });

    const callId = "call-stale-ts";
    const staleTs = Date.now() - 5 * 60_000; // 5 minutes old
    const sig = signHmac(SECRET, staleTs, callId);

    const ws = new WebSocket(`ws://127.0.0.1:${port}${PATH}/${callId}`, {
      headers: {
        "x-azurebot-timestamp": String(staleTs),
        "x-azurebot-signature": sig,
      },
    });

    const outcome = await new Promise<"unexpected-response" | "error" | "open">((resolve) => {
      ws.once("unexpected-response", () => resolve("unexpected-response"));
      ws.once("error", () => resolve("error"));
      ws.once("open", () => resolve("open"));
    });

    expect(outcome).not.toBe("open");
  });

  it("rejects upgrade missing the callId in the path", async () => {
    const port = randomPort();
    server = await startServer({ port });

    const ts = Date.now();
    const sig = signHmac(SECRET, ts, "");
    const ws = new WebSocket(`ws://127.0.0.1:${port}${PATH}`, {
      headers: {
        "x-azurebot-timestamp": String(ts),
        "x-azurebot-signature": sig,
      },
    });

    const outcome = await new Promise<"unexpected-response" | "error" | "open">((resolve) => {
      ws.once("unexpected-response", () => resolve("unexpected-response"));
      ws.once("error", () => resolve("error"));
      ws.once("open", () => resolve("open"));
    });

    expect(outcome).not.toBe("open");
  });

  it("decodes audio.frame and emits via onAudioFrame", async () => {
    const port = randomPort();
    const received: Array<{ callId: string; seq: number; payload: Buffer }> = [];
    server = await startServer({
      port,
      onAudioFrame: (info) => {
        received.push({ callId: info.callId, seq: info.seq, payload: info.payload });
      },
    });

    const callId = "call-audio";
    const ts = Date.now();
    const sig = signHmac(SECRET, ts, callId);
    const ws = new WebSocket(`ws://127.0.0.1:${port}${PATH}/${callId}`, {
      headers: {
        "x-azurebot-timestamp": String(ts),
        "x-azurebot-signature": sig,
      },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    const rawAudio = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    ws.send(
      JSON.stringify({
        type: "audio.frame",
        seq: 42,
        timestampMs: Date.now(),
        payloadBase64: rawAudio.toString("base64"),
      }),
    );

    await waitFor(() => received.length > 0);
    expect(received[0]?.callId).toBe(callId);
    expect(received[0]?.seq).toBe(42);
    expect(received[0]?.payload.equals(rawAudio)).toBe(true);

    ws.close();
  });

  it("session.end triggers onSessionEnd and closes the socket", async () => {
    const port = randomPort();
    let endInfo: { callId: string; reason: string } | undefined;
    server = await startServer({
      port,
      onSessionEnd: (info) => {
        endInfo = info;
      },
    });

    const callId = "call-end";
    const ts = Date.now();
    const sig = signHmac(SECRET, ts, callId);
    const ws = new WebSocket(`ws://127.0.0.1:${port}${PATH}/${callId}`, {
      headers: {
        "x-azurebot-timestamp": String(ts),
        "x-azurebot-signature": sig,
      },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    ws.send(JSON.stringify({ type: "session.end", reason: "call-ended" }));

    await waitFor(() => endInfo !== undefined);
    expect(endInfo?.callId).toBe(callId);
    expect(endInfo?.reason).toBe("call-ended");
  });

  it("drops the connection when an inbound frame exceeds the payload cap", async () => {
    const port = randomPort();
    let frames = 0;
    server = await startServer({
      port,
      onAudioFrame: () => {
        frames += 1;
      },
    });

    const callId = "call-oversize";
    const ts = Date.now();
    const sig = signHmac(SECRET, ts, callId);
    const ws = new WebSocket(`ws://127.0.0.1:${port}${PATH}/${callId}`, {
      headers: {
        "x-azurebot-timestamp": String(ts),
        "x-azurebot-signature": sig,
      },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    // ~70 KB base64 payload — over the 64 KB inbound cap. ws closes oversized
    // frames with code 1009 (message too big) before they reach JSON parsing.
    const closeCode = await new Promise<number>((resolve) => {
      ws.once("close", (code) => resolve(code));
      ws.send(
        JSON.stringify({
          type: "audio.frame",
          seq: 0,
          timestampMs: Date.now(),
          payloadBase64: "A".repeat(70 * 1024),
        }),
      );
    });

    expect(closeCode).toBe(1009);
    expect(frames).toBe(0);
  });
});
