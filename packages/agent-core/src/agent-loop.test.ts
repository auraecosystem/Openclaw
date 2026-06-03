import { createAssistantMessageEventStream } from "@openclaw/llm-core";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { agentLoop, agentLoopContinue } from "./agent-loop.js";
import type { Message, Model } from "./llm.js";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  StreamFn,
} from "./types.js";

const model: Model = {
  id: "test-model",
  name: "Test Model",
  api: "test-api",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 1000,
};

const config: AgentLoopConfig = {
  model,
  convertToLlm: (messages) => messages as Message[],
};

const failingStreamFn: StreamFn = async () => {
  throw new Error("provider exploded");
};

async function collectEvents(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function expectTerminalFailure(events: AgentEvent[], result: AgentMessage[]): void {
  expect(events.map((event) => event.type)).toContain("agent_end");
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    role: "assistant",
    stopReason: "error",
    errorMessage: "provider exploded",
  });
}

describe("agentLoop EventStream failures", () => {
  it("ends the public stream when a new prompt run rejects", async () => {
    const stream = agentLoop(
      [{ role: "user", content: "hello", timestamp: 1 }],
      { systemPrompt: "", messages: [] },
      config,
      undefined,
      failingStreamFn,
    );

    const events = await collectEvents(stream);
    const result = await stream.result();

    expectTerminalFailure(events, result);
  });

  it("ends the public stream when a continue run rejects", async () => {
    const context: AgentContext = {
      systemPrompt: "",
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
    };
    const stream = agentLoopContinue(context, config, undefined, failingStreamFn);

    const events = await collectEvents(stream);
    const result = await stream.result();

    expectTerminalFailure(events, result);
  });
});

describe("agentLoop tool execution names", () => {
  it("emits the registered tool name for a tts call", async () => {
    const assistantMessage: Message = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-tts",
          name: "tts",
          arguments: { text: "hello" },
        },
      ],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 1,
    };
    const ttsTool: AgentTool = {
      name: "tts",
      label: "TTS",
      description: "Text to speech",
      parameters: Type.Object({
        text: Type.String(),
      }),
      execute: vi.fn(async () => ({
        content: [{ type: "text", text: "audio generated" }],
        details: { media: { localPaths: ["/tmp/reply.opus"], trustedLocalMedia: true } },
      })),
    };
    const streamFn: StreamFn = () => {
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "toolUse", message: assistantMessage });
      return stream;
    };
    const stream = agentLoop(
      [{ role: "user", content: "speak this", timestamp: 1 }],
      { systemPrompt: "", messages: [], tools: [ttsTool] },
      {
        ...config,
        shouldStopAfterTurn: () => true,
      },
      undefined,
      streamFn,
    );

    const events = await collectEvents(stream);

    expect(ttsTool.execute).toHaveBeenCalledWith(
      "call-tts",
      { text: "hello" },
      undefined,
      expect.any(Function),
    );
    expect(
      events
        .filter(
          (event) => event.type === "tool_execution_start" || event.type === "tool_execution_end",
        )
        .map((event) => event.toolName),
    ).toEqual(["tts", "tts"]);
  });
});
