import type {
  AgentToolResultMiddleware,
  AgentToolResultMiddlewareOptions,
  AgentToolResultMiddlewareRuntime,
} from "./agent-tool-result-middleware-types.js";
import type {
  PluginAgentToolResultMiddlewareRegistration,
  PluginRegistry,
} from "./registry-types.js";
import { getActivePluginRegistry } from "./runtime.js";

export const AGENT_TOOL_RESULT_MIDDLEWARE_RUNTIMES = [
  "openclaw",
  "codex",
] as const satisfies AgentToolResultMiddlewareRuntime[];

const AGENT_TOOL_RESULT_MIDDLEWARE_RUNTIME_SET = new Set<string>(
  AGENT_TOOL_RESULT_MIDDLEWARE_RUNTIMES,
);

const LEGACY_AGENT_TOOL_RESULT_MIDDLEWARE_RUNTIMES = {
  "codex-app-server": "codex",
} as const satisfies Record<string, AgentToolResultMiddlewareRuntime>;

function normalizeAgentToolResultMiddlewareRuntime(
  runtime: string,
): AgentToolResultMiddlewareRuntime | undefined {
  const normalized = runtime.trim().toLowerCase();
  const legacyRuntime =
    LEGACY_AGENT_TOOL_RESULT_MIDDLEWARE_RUNTIMES[
      normalized as keyof typeof LEGACY_AGENT_TOOL_RESULT_MIDDLEWARE_RUNTIMES
    ];
  if (legacyRuntime) {
    return legacyRuntime;
  }
  return AGENT_TOOL_RESULT_MIDDLEWARE_RUNTIME_SET.has(normalized)
    ? (normalized as AgentToolResultMiddlewareRuntime)
    : undefined;
}

export function normalizeAgentToolResultMiddlewareRuntimes(
  options?: AgentToolResultMiddlewareOptions,
): AgentToolResultMiddlewareRuntime[] {
  const requested = options?.runtimes ?? options?.harnesses;
  if (!requested) {
    return [...AGENT_TOOL_RESULT_MIDDLEWARE_RUNTIMES];
  }
  const normalized: AgentToolResultMiddlewareRuntime[] = [];
  for (const runtime of requested) {
    const value = normalizeAgentToolResultMiddlewareRuntime(runtime);
    if (!value) {
      continue;
    }
    if (!normalized.includes(value)) {
      normalized.push(value);
    }
  }
  return normalized;
}

/** @deprecated Use normalizeAgentToolResultMiddlewareRuntimes. */
export const normalizeAgentToolResultMiddlewareHarnesses =
  normalizeAgentToolResultMiddlewareRuntimes;

export function normalizeAgentToolResultMiddlewareRuntimeIds(
  runtimes: readonly string[] | undefined,
): AgentToolResultMiddlewareRuntime[] {
  const normalized: AgentToolResultMiddlewareRuntime[] = [];
  for (const runtime of runtimes ?? []) {
    const value = normalizeAgentToolResultMiddlewareRuntime(runtime);
    if (value && !normalized.includes(value)) {
      normalized.push(value);
    }
  }
  return normalized;
}

type MiddlewareSnapshot =
  | {
      ok: true;
      handler: AgentToolResultMiddleware;
      runtimes: readonly AgentToolResultMiddlewareRuntime[];
    }
  | {
      ok: false;
    };

function listActiveMiddlewareRegistrations(): readonly PluginAgentToolResultMiddlewareRegistration[] {
  const registry = getActivePluginRegistry() as PluginRegistry | null | undefined;
  if (!registry) {
    return [];
  }
  try {
    return Array.isArray(registry.agentToolResultMiddlewares)
      ? registry.agentToolResultMiddlewares
      : [];
  } catch {
    return [];
  }
}

function snapshotMiddlewareRegistration(
  entry: PluginAgentToolResultMiddlewareRegistration,
): MiddlewareSnapshot {
  try {
    const { runtimes, handler } = entry;
    if (!Array.isArray(runtimes) || typeof handler !== "function") {
      return { ok: false };
    }
    return { ok: true, runtimes, handler };
  } catch {
    return { ok: false };
  }
}

export function listAgentToolResultMiddlewares(
  runtime: AgentToolResultMiddlewareRuntime,
): AgentToolResultMiddleware[] {
  const handlers: AgentToolResultMiddleware[] = [];
  for (const entry of listActiveMiddlewareRegistrations()) {
    const registration = snapshotMiddlewareRegistration(entry);
    if (registration.ok && registration.runtimes.includes(runtime)) {
      handlers.push(registration.handler);
    }
  }
  return handlers;
}
