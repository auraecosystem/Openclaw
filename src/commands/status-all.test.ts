import { beforeEach, describe, expect, it, vi } from "vitest";
import { statusAllCommand } from "./status-all.js";

const mocks = vi.hoisted(() => ({
  collectStatusScanOverview: vi.fn(),
  resolveStatusServiceSummaries: vi.fn(),
  resolveNodeOnlyGatewayInfo: vi.fn(),
  buildStatusAllReportData: vi.fn(),
  buildStatusAllReportLines: vi.fn(),
}));

vi.mock("../cli/progress.js", () => ({
  withProgress: async (_options: unknown, run: (progress: unknown) => Promise<void>) =>
    await run({
      setLabel: vi.fn(),
      tick: vi.fn(),
    }),
}));

vi.mock("./status.scan-overview.ts", () => ({
  collectStatusScanOverview: mocks.collectStatusScanOverview,
}));

vi.mock("./status-runtime-shared.ts", () => ({
  resolveStatusServiceSummaries: mocks.resolveStatusServiceSummaries,
}));

vi.mock("./status.node-mode.js", () => ({
  resolveNodeOnlyGatewayInfo: mocks.resolveNodeOnlyGatewayInfo,
}));

vi.mock("./status-all/report-data.js", () => ({
  buildStatusAllReportData: mocks.buildStatusAllReportData,
}));

vi.mock("./status-all/report-lines.js", () => ({
  buildStatusAllReportLines: mocks.buildStatusAllReportLines,
}));

describe("statusAllCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.collectStatusScanOverview.mockResolvedValue({ summary: "overview" });
    mocks.resolveStatusServiceSummaries.mockResolvedValue([
      { label: "Gateway service" },
      { label: "Node service" },
    ]);
    mocks.resolveNodeOnlyGatewayInfo.mockResolvedValue(null);
    mocks.buildStatusAllReportData.mockResolvedValue({});
    mocks.buildStatusAllReportLines.mockResolvedValue(["status all ok"]);
  });

  it("passes the status timeout into service summaries", async () => {
    const log = vi.fn();

    await statusAllCommand({ log } as never, { timeoutMs: 3000 });

    expect(mocks.resolveStatusServiceSummaries).toHaveBeenCalledWith({ timeoutMs: 3000 });
    expect(mocks.buildStatusAllReportData).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 3000,
        daemon: { label: "Gateway service" },
        nodeService: { label: "Node service" },
      }),
    );
    expect(log).toHaveBeenCalledWith("status all ok");
  });
});
