import { describe, expect, it } from "vitest";
import type {
  HangupCallInput,
  InitiateCallInput,
  PlayTtsInput,
  StartListeningInput,
  StopListeningInput,
  WebhookContext,
} from "../types.js";
import { MsteamsProvider } from "./msteams.js";

const STUB_WEBHOOK_CTX: WebhookContext = {
  rawBody: "",
  headers: {},
  url: "/",
} as unknown as WebhookContext;

const STUB_HANGUP_INPUT: HangupCallInput = {} as unknown as HangupCallInput;
const STUB_PLAY_TTS_INPUT: PlayTtsInput = {} as unknown as PlayTtsInput;
const STUB_START_LISTEN_INPUT: StartListeningInput = {} as unknown as StartListeningInput;
const STUB_STOP_LISTEN_INPUT: StopListeningInput = {} as unknown as StopListeningInput;
const STUB_INITIATE_INPUT: InitiateCallInput = {} as unknown as InitiateCallInput;

describe("MsteamsProvider", () => {
  it("identifies as the msteams provider", () => {
    const p = new MsteamsProvider({});
    expect(p.name).toBe("msteams");
  });

  it("verifyWebhook accepts unconditionally — Teams does not use the webhook plane", () => {
    const p = new MsteamsProvider({});
    expect(p.verifyWebhook(STUB_WEBHOOK_CTX)).toEqual({ ok: true });
  });

  it("parseWebhookEvent returns no events", () => {
    const p = new MsteamsProvider({});
    const result = p.parseWebhookEvent(STUB_WEBHOOK_CTX);
    expect(result.events).toEqual([]);
    expect(result.statusCode).toBe(204);
  });

  it("initiateCall throws — outbound dialing is out of Sprint 2 scope", async () => {
    const p = new MsteamsProvider({});
    await expect(p.initiateCall(STUB_INITIATE_INPUT)).rejects.toThrow(/inbound-only/);
  });

  it("hangupCall, playTts, startListening, stopListening are no-ops in Phase 2.0", async () => {
    const p = new MsteamsProvider({});
    await expect(p.hangupCall(STUB_HANGUP_INPUT)).resolves.toBeUndefined();
    await expect(p.playTts(STUB_PLAY_TTS_INPUT)).resolves.toBeUndefined();
    await expect(p.startListening(STUB_START_LISTEN_INPUT)).resolves.toBeUndefined();
    await expect(p.stopListening(STUB_STOP_LISTEN_INPUT)).resolves.toBeUndefined();
  });

  it("getCallStatus reports in-progress (status comes from WS lifecycle, not webhooks)", async () => {
    const p = new MsteamsProvider({});
    const status = await p.getCallStatus({
      providerCallId: "anything",
    } as unknown as Parameters<MsteamsProvider["getCallStatus"]>[0]);
    expect(status.status).toBe("in-progress");
    expect(status.isTerminal).toBe(false);
  });
});
