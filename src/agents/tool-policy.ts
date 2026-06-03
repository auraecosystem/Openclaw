import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { sanitizeServerName, TOOL_NAME_SEPARATOR } from "./agent-bundle-mcp-names.js";
import { IMPLICIT_ALLOW_ALL_FROM_ALSO_ALLOW } from "./sandbox-tool-policy.js";
import { expandToolGroups, normalizeToolList, normalizeToolName } from "./tool-policy-shared.js";
export {
  couldNormalizeToolNamePrefixToAllowedTool,
  expandToolGroups,
  normalizeToolList,
  normalizeToolName,
  resolveToolProfilePolicy,
  TOOL_GROUPS,
} from "./tool-policy-shared.js";
export type { ToolProfileId } from "./tool-policy-shared.js";

export type ToolPolicyLike = {
  allow?: string[];
  deny?: string[];
  [IMPLICIT_ALLOW_ALL_FROM_ALSO_ALLOW]?: true;
};

export type PluginToolGroups = {
  all: string[];
  byPlugin: Map<string, string[]>;
};

export type AllowlistResolution = {
  policy: ToolPolicyLike | undefined;
  unknownAllowlist: string[];
  pluginOnlyAllowlist: boolean;
};

export type DeclaredToolAllowlistContext = {
  pluginToolNames?: Iterable<string>;
  pluginIds?: Iterable<string>;
  mcpServerNames?: Iterable<string>;
};

export const DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY = "__openclaw_default_plugin_tools__";

export function hasRestrictiveAllowPolicy(policy?: { allow?: string[] }): boolean {
  return (
    Array.isArray(policy?.allow) &&
    policy.allow.some((entry) => {
      const normalized = normalizeToolName(entry);
      return (
        Boolean(normalized) &&
        normalized !== "*" &&
        normalized !== DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY
      );
    })
  );
}

export function replaceWithEffectiveToolAllowlist(
  target: string[],
  tools: Array<{ name: string }>,
): void {
  target.length = 0;
  const seen = new Set<string>();
  for (const tool of tools) {
    const normalized = normalizeToolName(tool.name);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    target.push(normalized);
  }
}

export function collectExplicitAllowlist(policies: Array<ToolPolicyLike | undefined>): string[] {
  const entries: string[] = [];
  for (const policy of policies) {
    if (!policy?.allow) {
      continue;
    }
    for (const value of policy.allow) {
      if (typeof value !== "string") {
        continue;
      }
      const trimmed = value.trim();
      if (trimmed === "*" && policy[IMPLICIT_ALLOW_ALL_FROM_ALSO_ALLOW] === true) {
        continue;
      }
      if (trimmed) {
        entries.push(trimmed);
      }
    }
    if (policy[IMPLICIT_ALLOW_ALL_FROM_ALSO_ALLOW] === true) {
      entries.push(DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY);
    }
  }
  return uniqueStrings(entries);
}

export function collectExplicitDenylist(policies: Array<ToolPolicyLike | undefined>): string[] {
  const entries: string[] = [];
  for (const policy of policies) {
    if (!policy?.deny) {
      continue;
    }
    for (const value of policy.deny) {
      if (typeof value !== "string") {
        continue;
      }
      const trimmed = value.trim();
      if (trimmed) {
        entries.push(trimmed);
      }
    }
  }
  return entries;
}

export function buildPluginToolGroups<T extends { name: string }>(params: {
  tools: T[];
  toolMeta: (tool: T) => { pluginId: string } | undefined;
}): PluginToolGroups {
  const all: string[] = [];
  const byPlugin = new Map<string, string[]>();
  for (const tool of params.tools) {
    const meta = params.toolMeta(tool);
    if (!meta) {
      continue;
    }
    const name = normalizeToolName(tool.name);
    all.push(name);
    const pluginId = normalizeOptionalLowercaseString(meta.pluginId);
    if (!pluginId) {
      continue;
    }
    const list = byPlugin.get(pluginId) ?? [];
    list.push(name);
    byPlugin.set(pluginId, list);
  }
  return { all, byPlugin };
}

export function expandPluginGroups(
  list: string[] | undefined,
  groups: PluginToolGroups,
): string[] | undefined {
  if (!list || list.length === 0) {
    return list;
  }
  const expanded: string[] = [];
  for (const entry of list) {
    const normalized = normalizeToolName(entry);
    if (normalized === "group:plugins") {
      if (groups.all.length > 0) {
        expanded.push(...groups.all);
      } else {
        expanded.push(normalized);
      }
      continue;
    }
    const tools = groups.byPlugin.get(normalized);
    if (tools && tools.length > 0) {
      expanded.push(...tools);
      continue;
    }
    expanded.push(normalized);
  }
  return uniqueStrings(expanded);
}

export function expandPolicyWithPluginGroups(
  policy: ToolPolicyLike | undefined,
  groups: PluginToolGroups,
): ToolPolicyLike | undefined {
  if (!policy) {
    return undefined;
  }
  return {
    allow: expandPluginGroups(policy.allow, groups),
    deny: expandPluginGroups(policy.deny, groups),
  };
}

function buildDeclaredMcpToolPrefixes(serverNames?: Iterable<string>): Set<string> {
  const prefixes = new Set<string>();
  const usedNames = new Set<string>();
  for (const serverName of serverNames ?? []) {
    const safeName = sanitizeServerName(serverName, usedNames);
    const prefix = normalizeToolName(safeName + TOOL_NAME_SEPARATOR);
    if (prefix) {
      prefixes.add(prefix);
    }
  }
  return prefixes;
}

function normalizeDeclaredPluginIds(values?: Iterable<string>): Set<string> {
  return new Set(
    Array.from(values ?? [], (value) => normalizeOptionalLowercaseString(value)).filter(
      (value): value is string => Boolean(value),
    ),
  );
}

function normalizeDeclaredToolNames(values?: Iterable<string>): Set<string> {
  return new Set(
    Array.from(values ?? [], (value) => normalizeToolName(value)).filter((value): value is string =>
      Boolean(value),
    ),
  );
}

function isDeclaredMcpAllowlistEntry(entry: string, prefixes: Set<string>): boolean {
  if (prefixes.size === 0) {
    return false;
  }
  if (entry === "bundle-mcp") {
    return true;
  }
  for (const prefix of prefixes) {
    if (entry.length > prefix.length && entry.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

export function analyzeAllowlistByToolType(
  policy: ToolPolicyLike | undefined,
  groups: PluginToolGroups,
  coreTools: Set<string>,
  declaredTools?: DeclaredToolAllowlistContext,
): AllowlistResolution {
  if (!policy?.allow || policy.allow.length === 0) {
    return { policy, unknownAllowlist: [], pluginOnlyAllowlist: false };
  }
  const normalized = normalizeToolList(policy.allow);
  if (normalized.length === 0) {
    return { policy, unknownAllowlist: [], pluginOnlyAllowlist: false };
  }
  const pluginIds = new Set([
    ...groups.byPlugin.keys(),
    ...normalizeDeclaredPluginIds(declaredTools?.pluginIds),
  ]);
  const pluginTools = new Set([
    ...groups.all,
    ...normalizeDeclaredToolNames(declaredTools?.pluginToolNames),
  ]);
  const mcpToolPrefixes = buildDeclaredMcpToolPrefixes(declaredTools?.mcpServerNames);
  const unknownAllowlist: string[] = [];
  let hasOnlyPluginEntries = true;
  for (const entry of normalized) {
    if (entry === "*") {
      hasOnlyPluginEntries = false;
      continue;
    }
    const isPluginEntry =
      entry === "group:plugins" ||
      pluginIds.has(entry) ||
      pluginTools.has(entry) ||
      isDeclaredMcpAllowlistEntry(entry, mcpToolPrefixes);
    const expanded = expandToolGroups([entry]);
    const isCoreEntry = expanded.some((tool) => coreTools.has(tool));
    if (!isPluginEntry) {
      hasOnlyPluginEntries = false;
    }
    if (!isCoreEntry && !isPluginEntry) {
      unknownAllowlist.push(entry);
    }
  }
  const pluginOnlyAllowlist = hasOnlyPluginEntries;
  return {
    policy,
    unknownAllowlist: uniqueStrings(unknownAllowlist),
    pluginOnlyAllowlist,
  };
}

export function mergeAlsoAllowPolicy<TPolicy extends { allow?: string[] }>(
  policy: TPolicy | undefined,
  alsoAllow?: string[],
): TPolicy | undefined {
  if (!policy?.allow || !Array.isArray(alsoAllow) || alsoAllow.length === 0) {
    return policy;
  }
  return { ...policy, allow: uniqueStrings([...policy.allow, ...alsoAllow]) };
}
