import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayService } from "./service.js";
import { createMockGatewayService } from "./service.test-helpers.js";

const mocks = vi.hoisted(() => ({
  resolveGatewayService: vi.fn<() => GatewayService>(),
}));

vi.mock("./service.js", async () => {
  const actual = await vi.importActual<typeof import("./service.js")>("./service.js");
  return {
    ...actual,
    resolveGatewayService: mocks.resolveGatewayService,
  };
});

const { resolveNodeService } = await import("./node-service.js");

describe("resolveNodeService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveGatewayService.mockReturnValue(createMockGatewayService());
  });

  it("preserves service timeout options on node service probes", async () => {
    const base = createMockGatewayService({
      isLoaded: vi.fn(async () => true),
      readRuntime: vi.fn(async () => ({ status: "running" })),
    });
    mocks.resolveGatewayService.mockReturnValue(base);

    const service = resolveNodeService();
    await service.isLoaded({ env: { CUSTOM: "1" }, timeoutMs: 3000 });
    await service.readRuntime({ CUSTOM: "1" }, { timeoutMs: 3000 });

    expect(base.isLoaded).toHaveBeenCalledWith({
      timeoutMs: 3000,
      env: expect.objectContaining({
        CUSTOM: "1",
        OPENCLAW_SERVICE_KIND: "node",
        OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: "1",
      }),
    });
    expect(base.readRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        CUSTOM: "1",
        OPENCLAW_SERVICE_KIND: "node",
        OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: "1",
      }),
      { timeoutMs: 3000 },
    );
  });
});
