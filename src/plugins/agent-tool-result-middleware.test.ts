import { afterEach, describe, expect, it } from "vitest";
import {
  listAgentToolResultMiddlewares,
  normalizeAgentToolResultMiddlewareRuntimes,
} from "./agent-tool-result-middleware.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginAgentToolResultMiddlewareRegistration } from "./registry-types.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

describe("normalizeAgentToolResultMiddlewareRuntimes", () => {
  it("defaults omitted runtimes to every supported runtime", () => {
    expect(normalizeAgentToolResultMiddlewareRuntimes()).toEqual(["openclaw", "codex"]);
  });

  it("preserves an explicit empty runtime list", () => {
    expect(normalizeAgentToolResultMiddlewareRuntimes({ runtimes: [] })).toEqual([]);
  });

  it("normalizes legacy harness names", () => {
    expect(
      normalizeAgentToolResultMiddlewareRuntimes({ harnesses: ["codex-app-server", "openclaw"] }),
    ).toEqual(["codex", "openclaw"]);
  });

  it("falls back to legacy harnesses when runtimes is undefined", () => {
    expect(
      normalizeAgentToolResultMiddlewareRuntimes({
        runtimes: undefined,
        harnesses: ["codex-app-server"],
      }),
    ).toEqual(["codex"]);
  });
});

describe("listAgentToolResultMiddlewares", () => {
  it("skips unreadable middleware siblings while preserving healthy handlers", () => {
    const registry = createEmptyPluginRegistry();
    const handler = () => undefined;
    registry.agentToolResultMiddlewares = [
      {
        pluginId: "broken-middleware",
        source: "test",
        get runtimes() {
          throw new Error("middleware runtimes getter exploded");
        },
        handler: () => undefined,
      } as PluginAgentToolResultMiddlewareRegistration,
      {
        pluginId: "healthy-middleware",
        source: "test",
        runtimes: ["codex"],
        handler,
      } as PluginAgentToolResultMiddlewareRegistration,
    ];
    setActivePluginRegistry(registry);

    expect(listAgentToolResultMiddlewares("codex")).toEqual([handler]);
  });
});
