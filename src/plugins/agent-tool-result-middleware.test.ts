import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listAgentToolResultMiddlewares,
  normalizeAgentToolResultMiddlewareRuntimes,
} from "./agent-tool-result-middleware.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";

describe("agent tool result middleware", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

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

  it("keeps healthy middlewares after unreadable middleware metadata", () => {
    const registry = createEmptyPluginRegistry();
    const healthy = vi.fn();
    registry.agentToolResultMiddlewares.push(
      Object.defineProperty(
        {
          pluginId: "stale",
          source: "test",
        },
        "runtimes",
        {
          get() {
            throw new Error("agent tool result middleware runtimes getter exploded");
          },
        },
      ) as (typeof registry.agentToolResultMiddlewares)[number],
      {
        pluginId: "healthy",
        rawHandler: healthy,
        handler: healthy,
        runtimes: ["codex"],
        source: "test",
      },
    );
    setActivePluginRegistry(registry);

    expect(listAgentToolResultMiddlewares("codex")).toEqual([healthy]);
  });
});
