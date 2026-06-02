import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { MemoryQmdUpdateConfig } from "../config/types.memory.js";

const { getMemorySearchManagerMock } = vi.hoisted(() => ({
  getMemorySearchManagerMock: vi.fn(),
}));

vi.mock("../plugins/memory-runtime.js", () => ({
  getActiveMemorySearchManager: getMemorySearchManagerMock,
}));

import {
  startGatewayMemoryBackend,
  startGatewayMemorySessionListeners,
} from "./server-startup-memory.js";

function createQmdConfig(
  agents: OpenClawConfig["agents"],
  update: MemoryQmdUpdateConfig = { startup: "immediate" },
): OpenClawConfig {
  return {
    agents,
    memory: { backend: "qmd", qmd: { update } },
  } as OpenClawConfig;
}

function createGatewayLogMock() {
  return { info: vi.fn(), warn: vi.fn() };
}

function createQmdManagerMock() {
  return {
    search: vi.fn(),
    sync: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

async function startMemoryBackendForTest(cfg: OpenClawConfig) {
  const log = createGatewayLogMock();
  await startGatewayMemoryBackend({ cfg, log });
  return log;
}

async function startQmdBackendWithManager(cfg: OpenClawConfig) {
  getMemorySearchManagerMock.mockResolvedValue({ manager: createQmdManagerMock() });
  return await startMemoryBackendForTest(cfg);
}

function expectNoMemoryBackendStartup(log: ReturnType<typeof createGatewayLogMock>) {
  expect(getMemorySearchManagerMock).not.toHaveBeenCalled();
  expect(log.info).not.toHaveBeenCalled();
  expect(log.warn).not.toHaveBeenCalled();
}

function expectQmdManagerRequests(cfg: OpenClawConfig, agentIds: string[]) {
  expect(getMemorySearchManagerMock).toHaveBeenCalledTimes(agentIds.length);
  for (const [index, agentId] of agentIds.entries()) {
    expect(getMemorySearchManagerMock).toHaveBeenNthCalledWith(index + 1, {
      cfg,
      agentId,
      purpose: "cli",
    });
  }
}

function expectBootSyncCompleted(
  log: ReturnType<typeof createGatewayLogMock>,
  count: number,
  agents: string,
) {
  const noun = count === 1 ? "agent" : "agents";
  expect(log.info).toHaveBeenCalledWith(
    `qmd memory startup boot sync completed for ${count} ${noun}: ${agents}`,
  );
}

describe("startGatewayMemoryBackend", () => {
  beforeEach(() => {
    getMemorySearchManagerMock.mockClear();
  });

  it("skips initialization when memory backend is not qmd", async () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
      memory: { backend: "builtin" },
    } as OpenClawConfig;

    const log = await startMemoryBackendForTest(cfg);

    expectNoMemoryBackendStartup(log);
  });

  it("keeps qmd managers lazy when startup refresh is not opted in", async () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
      memory: { backend: "qmd", qmd: {} },
    } as OpenClawConfig;

    const log = await startMemoryBackendForTest(cfg);

    expectNoMemoryBackendStartup(log);
  });

  it("runs qmd boot sync for the default and explicitly configured agents", async () => {
    const cfg = createQmdConfig({
      list: [
        { id: "ops", default: true },
        { id: "main", memorySearch: { enabled: true } },
        { id: "lazy" },
      ],
    });

    const log = await startQmdBackendWithManager(cfg);

    expectQmdManagerRequests(cfg, ["ops", "main"]);
    expectBootSyncCompleted(log, 2, '"ops", "main"');
    expect(log.info).toHaveBeenCalledWith(
      'qmd memory startup initialization deferred for 1 agent: "lazy"',
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("initializes all qmd agents when memory search is explicitly enabled in defaults", async () => {
    const cfg = createQmdConfig({
      defaults: { memorySearch: { enabled: true } },
      list: [{ id: "ops", default: true }, { id: "main" }],
    });

    const log = await startQmdBackendWithManager(cfg);

    expectQmdManagerRequests(cfg, ["ops", "main"]);
    expectBootSyncCompleted(log, 2, '"ops", "main"');
    expect(log.info.mock.calls.some(([message]) => String(message).includes("deferred"))).toBe(
      false,
    );
  });

  it("logs a warning when qmd manager init fails and continues with other agents", async () => {
    const cfg = createQmdConfig({
      list: [
        { id: "main", default: true },
        { id: "ops", memorySearch: { enabled: true } },
      ],
    });
    const log = createGatewayLogMock();
    getMemorySearchManagerMock
      .mockResolvedValueOnce({ manager: null, error: "qmd missing" })
      .mockResolvedValueOnce({ manager: createQmdManagerMock() });

    await startGatewayMemoryBackend({ cfg, log });

    expect(log.warn).toHaveBeenCalledWith(
      'qmd memory startup initialization failed for agent "main": qmd missing',
    );
    expectBootSyncCompleted(log, 1, '"ops"');
  });

  it("skips agents with memory search disabled", async () => {
    const cfg = createQmdConfig({
      defaults: { memorySearch: { enabled: true } },
      list: [
        { id: "main", default: true },
        { id: "ops", memorySearch: { enabled: false } },
      ],
    });

    const log = await startQmdBackendWithManager(cfg);

    expectQmdManagerRequests(cfg, ["main"]);
    expectBootSyncCompleted(log, 1, '"main"');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("does not initialize qmd managers when background work is disabled", async () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
      memory: {
        backend: "qmd",
        qmd: {
          update: { startup: "immediate", onBoot: false, interval: "0s", embedInterval: "0s" },
        },
      },
    } as OpenClawConfig;

    const log = await startMemoryBackendForTest(cfg);

    expectNoMemoryBackendStartup(log);
  });
});

describe("startGatewayMemorySessionListeners", () => {
  beforeEach(() => {
    getMemorySearchManagerMock.mockClear();
  });

  function createBuiltinSessionsConfig(): OpenClawConfig {
    return {
      agents: {
        list: [{ id: "main", default: true }],
        defaults: {
          memorySearch: {
            enabled: true,
            sources: ["memory", "sessions"],
            // Codex review (#76666 P3): `resolveMemorySearchConfig` strips the
            // "sessions" source when `experimental.sessionMemory` is false,
            // which would make the success-path test pass even if preload
            // stopped arming listeners. Flag on so the resolver keeps the
            // sessions source and `getActiveMemorySearchManager` is reached.
            experimental: { sessionMemory: true },
          },
        },
      },
      memory: { backend: "builtin" },
    } as OpenClawConfig;
  }

  function createBuiltinNoSessionsConfig(): OpenClawConfig {
    return {
      agents: {
        list: [{ id: "main", default: true }],
        defaults: {
          memorySearch: {
            enabled: true,
            sources: ["memory"],
            experimental: { sessionMemory: true },
          },
        },
      },
      memory: { backend: "builtin" },
    } as OpenClawConfig;
  }

  it("skips agents that do not request the sessions source", async () => {
    const cfg = createBuiltinNoSessionsConfig();
    const log = createGatewayLogMock();

    await startGatewayMemorySessionListeners({ cfg, log });

    expect(getMemorySearchManagerMock).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("does not close the manager when preload succeeds (listener must remain subscribed)", async () => {
    // This regression-guards the whole point of the preload: if close() were
    // called, ensureSessionListener's sessionUnsubscribe would immediately
    // fire and drop us back to the same lazy-load state that causes the
    // archive emit to land in an empty listener set.
    const closeSpy = vi.fn(async () => undefined);
    getMemorySearchManagerMock.mockResolvedValue({
      manager: { search: vi.fn(), close: closeSpy },
    });
    const cfg = createBuiltinSessionsConfig();
    const log = createGatewayLogMock();

    await startGatewayMemorySessionListeners({ cfg, log });

    // Codex review (#76666 P3): assert the resolver path actually reaches
    // getActiveMemorySearchManager. Without this, a regression that breaks
    // preload arming (e.g. resolver strips sessions source) would still pass
    // the close-check.
    expect(getMemorySearchManagerMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "main" }),
    );
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it("never throws even if manager acquisition rejects", async () => {
    getMemorySearchManagerMock.mockRejectedValue(new Error("provider unreachable"));
    const cfg = createBuiltinSessionsConfig();
    const log = createGatewayLogMock();

    // Startup must never blow up the gateway: failures are swallowed and
    // logged (when the mock is actually reached; per-agent filtering may
    // short-circuit before the call). Either way, this call must resolve.
    await expect(startGatewayMemorySessionListeners({ cfg, log })).resolves.toBeUndefined();
  });

  it("skips preload entirely when memory.backend is qmd (Codex review scope guard)", async () => {
    // Codex review on #76666 flagged that the qmd backend returns a
    // FallbackMemoryManager wrapper whose inner MemoryIndexManager is only
    // lazily constructed via `fallbackFactory`, so calling
    // `getActiveMemorySearchManager` under qmd would NOT run
    // `ensureSessionListener()`. Arming the qmd listener owner is deferred
    // to a follow-up PR; this preload explicitly skips qmd to keep the
    // advertised scope accurate (builtin-only).
    const cfg = createQmdConfig({
      defaults: { memorySearch: { enabled: true, sources: ["sessions"] } },
    } as unknown as OpenClawConfig["agents"]);
    const log = createGatewayLogMock();

    await startGatewayMemorySessionListeners({ cfg, log });

    expect(getMemorySearchManagerMock).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("qmd backend is intentionally out of scope"),
    );
  });
});
