import { resolveNodeService } from "../daemon/node-service.js";
import { resolveGatewayService } from "../daemon/service.js";
import { formatDaemonRuntimeShort } from "./status.format.js";
import { readServiceStatusSummary } from "./status.service-summary.js";

type DaemonStatusSummary = {
  label: string;
  installed: boolean | null;
  loaded: boolean;
  managedByOpenClaw: boolean;
  externallyManaged: boolean;
  loadedText: string;
  runtime: Awaited<ReturnType<typeof readServiceStatusSummary>>["runtime"];
  runtimeShort: string | null;
  layout: Awaited<ReturnType<typeof readServiceStatusSummary>>["layout"];
};

async function buildDaemonStatusSummary(params: {
  serviceLabel: "gateway" | "node";
  timeoutMs?: number;
}): Promise<DaemonStatusSummary> {
  const { serviceLabel } = params;
  const service = serviceLabel === "gateway" ? resolveGatewayService() : resolveNodeService();
  const fallbackLabel = serviceLabel === "gateway" ? "Daemon" : "Node";
  const summary =
    params.timeoutMs === undefined
      ? await readServiceStatusSummary(service, fallbackLabel)
      : await readServiceStatusSummary(service, fallbackLabel, { timeoutMs: params.timeoutMs });
  return {
    label: summary.label,
    installed: summary.installed,
    loaded: summary.loaded,
    managedByOpenClaw: summary.managedByOpenClaw,
    externallyManaged: summary.externallyManaged,
    loadedText: summary.loadedText,
    runtime: summary.runtime,
    runtimeShort: formatDaemonRuntimeShort(summary.runtime),
    layout: summary.layout,
  };
}

export async function getDaemonStatusSummary(
  params: { timeoutMs?: number } = {},
): Promise<DaemonStatusSummary> {
  return await buildDaemonStatusSummary({
    serviceLabel: "gateway",
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
  });
}

export async function getNodeDaemonStatusSummary(
  params: { timeoutMs?: number } = {},
): Promise<DaemonStatusSummary> {
  return await buildDaemonStatusSummary({
    serviceLabel: "node",
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
  });
}
