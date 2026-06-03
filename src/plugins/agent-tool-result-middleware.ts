import type {
  AgentToolResultMiddleware,
  AgentToolResultMiddlewareOptions,
  AgentToolResultMiddlewareRuntime,
} from "./agent-tool-result-middleware-types.js";
import type { PluginAgentToolResultMiddlewareRegistration } from "./registry-types.js";
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

function readAgentToolResultMiddleware(
  entry: PluginAgentToolResultMiddlewareRegistration,
  runtime: AgentToolResultMiddlewareRuntime,
): AgentToolResultMiddleware | null {
  try {
    if (!entry.runtimes.includes(runtime)) {
      return null;
    }
    return typeof entry.handler === "function" ? entry.handler : null;
  } catch {
    return null;
  }
}

export function listAgentToolResultMiddlewares(
  runtime: AgentToolResultMiddlewareRuntime,
): AgentToolResultMiddleware[] {
  return (
    getActivePluginRegistry()?.agentToolResultMiddlewares?.flatMap((entry) => {
      const handler = readAgentToolResultMiddleware(entry, runtime);
      return handler ? [handler] : [];
    }) ?? []
  );
}
