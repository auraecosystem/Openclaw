import { describe, expect, it } from "vitest";
import type { Tool } from "./types.js";
import { validateToolArguments } from "./validation.js";

const decimalTool = {
  name: "decimal-tool",
  description: "test tool",
  parameters: {
    type: "object",
    properties: {
      amount: { type: "number" },
      count: { type: "integer" },
    },
    required: ["amount", "count"],
    additionalProperties: false,
  },
} as Tool;

describe("validateToolArguments", () => {
  it("coerces strict decimal numeric strings for plain JSON schemas", () => {
    expect(
      validateToolArguments(decimalTool, {
        type: "toolCall",
        id: "call-1",
        name: "decimal-tool",
        arguments: { amount: "1e3", count: "+3" },
      }),
    ).toEqual({ amount: 1000, count: 3 });
  });

  it("rejects non-decimal numeric strings for plain JSON schemas", () => {
    expect(() =>
      validateToolArguments(decimalTool, {
        type: "toolCall",
        id: "call-1",
        name: "decimal-tool",
        arguments: { amount: "0x10", count: "0b10" },
      }),
    ).toThrow(/Validation failed for tool "decimal-tool"/);
  });

  it("reports unreadable nested schema maps before TypeBox traversal", () => {
    const unreadableProperties = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("llm properties ownKeys exploded");
        },
      },
    );
    const tool = {
      name: "hostile-tool",
      description: "test tool",
      parameters: {
        type: "object",
        properties: unreadableProperties,
        additionalProperties: { type: "number" },
      },
    } as unknown as Tool;

    expect(() =>
      validateToolArguments(tool, {
        type: "toolCall",
        id: "call-1",
        name: "hostile-tool",
        arguments: { amount: "42" },
      }),
    ).toThrow(
      'Unsupported tool schema for "hostile-tool": unreadable schema at parameters.properties',
    );
  });

  it("reports unreadable root schemas before TypeBox traversal", () => {
    const unreadableParameters = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("llm root ownKeys exploded");
        },
      },
    );
    const tool = {
      name: "root-hostile-tool",
      description: "test tool",
      parameters: unreadableParameters,
    } as unknown as Tool;

    expect(() =>
      validateToolArguments(tool, {
        type: "toolCall",
        id: "call-1",
        name: "root-hostile-tool",
        arguments: {},
      }),
    ).toThrow('Unsupported tool schema for "root-hostile-tool": unreadable schema at parameters');
  });
});
