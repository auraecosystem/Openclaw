import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { isKnownCoreToolId } from "./tool-catalog.js";
import { auditToolPolicyFilter, type ToolPolicyAuditLogLevel } from "./tool-policy-audit.js";
import { isToolAllowedByPolicyName } from "./tool-policy-match.js";
import {
  analyzeAllowlistByToolType,
  expandPolicyWithPluginGroups,
  normalizeToolName,
  type PluginToolGroups,
  type ToolPolicyLike,
} from "./tool-policy.js";

const MAX_TOOL_POLICY_WARNING_CACHE = 256;
const seenToolPolicyWarnings = new Set<string>();
const toolPolicyWarningOrder: string[] = [];

function rememberToolPolicyWarning(warning: string): boolean {
  if (seenToolPolicyWarnings.has(warning)) {
    return false;
  }
  if (seenToolPolicyWarnings.size >= MAX_TOOL_POLICY_WARNING_CACHE) {
    const oldest = toolPolicyWarningOrder.shift();
    if (oldest) {
      seenToolPolicyWarnings.delete(oldest);
    }
  }
  seenToolPolicyWarnings.add(warning);
  toolPolicyWarningOrder.push(warning);
  return true;
}

export type ToolPolicyPipelineStep = {
  policy: ToolPolicyLike | undefined;
  label: string;
  stripPluginOnlyAllowlist?: boolean;
  suppressUnavailableCoreToolWarning?: boolean;
  suppressUnavailableCoreToolWarningAllowlist?: string[];
  unavailableCoreToolReason?: string;
};

type PolicyToolEntry = {
  tool: AnyAgentTool;
  name: string;
};

function readPolicyToolName(tool: AnyAgentTool): { ok: true; name: string } | { ok: false } {
  try {
    const name = normalizeToolName(tool.name);
    return name ? { ok: true, name } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function readPolicyToolEntries(params: {
  tools: readonly AnyAgentTool[];
  warn: (message: string) => void;
}): PolicyToolEntry[] {
  let length: number;
  try {
    length = params.tools.length;
  } catch {
    params.warn("tools: policy filtering skipped unreadable tool list.");
    return [];
  }
  const entries: PolicyToolEntry[] = [];
  for (let index = 0; index < length; index += 1) {
    let tool: AnyAgentTool;
    try {
      tool = params.tools[index];
    } catch {
      params.warn(`tools: policy filtering skipped unreadable tool at index ${index}.`);
      continue;
    }
    const nameRead = readPolicyToolName(tool);
    if (!nameRead.ok) {
      params.warn(`tools: policy filtering skipped tool with unreadable name at index ${index}.`);
      continue;
    }
    entries.push({ tool, name: nameRead.name });
  }
  return entries;
}

function buildPluginToolGroupsForPolicyEntries(params: {
  entries: readonly PolicyToolEntry[];
  toolMeta: (tool: AnyAgentTool) => { pluginId: string } | undefined;
}): PluginToolGroups {
  const all: string[] = [];
  const byPlugin = new Map<string, string[]>();
  for (const entry of params.entries) {
    const meta = params.toolMeta(entry.tool);
    if (!meta) {
      continue;
    }
    all.push(entry.name);
    const pluginId = normalizeOptionalLowercaseString(meta.pluginId);
    if (!pluginId) {
      continue;
    }
    const list = byPlugin.get(pluginId) ?? [];
    list.push(entry.name);
    byPlugin.set(pluginId, list);
  }
  return { all, byPlugin };
}

function filterPolicyEntriesByPolicy(
  entries: readonly PolicyToolEntry[],
  policy?: ToolPolicyLike,
): PolicyToolEntry[] {
  if (!policy) {
    return [...entries];
  }
  return entries.filter((entry) => isToolAllowedByPolicyName(entry.name, policy));
}

function policyAuditTools(entries: readonly PolicyToolEntry[]): Array<{ name: string }> {
  return entries.map((entry) => ({ name: entry.name }));
}

export function buildDefaultToolPolicyPipelineSteps(params: {
  profilePolicy?: ToolPolicyLike;
  profile?: string;
  profileUnavailableCoreWarningAllowlist?: string[];
  providerProfilePolicy?: ToolPolicyLike;
  providerProfile?: string;
  providerProfileUnavailableCoreWarningAllowlist?: string[];
  globalPolicy?: ToolPolicyLike;
  globalProviderPolicy?: ToolPolicyLike;
  agentPolicy?: ToolPolicyLike;
  agentProviderPolicy?: ToolPolicyLike;
  groupPolicy?: ToolPolicyLike;
  senderPolicy?: ToolPolicyLike;
  agentId?: string;
  unavailableCoreToolReason?: string;
}): ToolPolicyPipelineStep[] {
  const agentId = params.agentId?.trim();
  const profile = params.profile?.trim();
  const providerProfile = params.providerProfile?.trim();
  const unavailableCoreToolReason = params.unavailableCoreToolReason?.trim();
  return [
    {
      policy: params.profilePolicy,
      label: profile ? `tools.profile (${profile})` : "tools.profile",
      stripPluginOnlyAllowlist: true,
      suppressUnavailableCoreToolWarningAllowlist: params.profileUnavailableCoreWarningAllowlist,
      unavailableCoreToolReason,
    },
    {
      policy: params.providerProfilePolicy,
      label: providerProfile
        ? `tools.byProvider.profile (${providerProfile})`
        : "tools.byProvider.profile",
      stripPluginOnlyAllowlist: true,
      suppressUnavailableCoreToolWarningAllowlist:
        params.providerProfileUnavailableCoreWarningAllowlist,
      unavailableCoreToolReason,
    },
    {
      policy: params.globalPolicy,
      label: "tools.allow",
      stripPluginOnlyAllowlist: true,
      unavailableCoreToolReason,
    },
    {
      policy: params.globalProviderPolicy,
      label: "tools.byProvider.allow",
      stripPluginOnlyAllowlist: true,
      unavailableCoreToolReason,
    },
    {
      policy: params.agentPolicy,
      label: agentId ? `agents.${agentId}.tools.allow` : "agent tools.allow",
      stripPluginOnlyAllowlist: true,
      unavailableCoreToolReason,
    },
    {
      policy: params.agentProviderPolicy,
      label: agentId ? `agents.${agentId}.tools.byProvider.allow` : "agent tools.byProvider.allow",
      stripPluginOnlyAllowlist: true,
      unavailableCoreToolReason,
    },
    {
      policy: params.groupPolicy,
      label: "group tools.allow",
      stripPluginOnlyAllowlist: true,
      unavailableCoreToolReason,
    },
    {
      policy: params.senderPolicy,
      label: "tools.toolsBySender",
      stripPluginOnlyAllowlist: true,
      unavailableCoreToolReason,
    },
  ];
}

export function applyToolPolicyPipeline(params: {
  tools: AnyAgentTool[];
  toolMeta: (tool: AnyAgentTool) => { pluginId: string } | undefined;
  warn: (message: string) => void;
  steps: ToolPolicyPipelineStep[];
  auditLogLevel?: ToolPolicyAuditLogLevel;
}): AnyAgentTool[] {
  const entries = readPolicyToolEntries({ tools: params.tools, warn: params.warn });
  const coreToolNames = new Set(
    entries.filter((entry) => !params.toolMeta(entry.tool)).map((entry) => entry.name),
  );

  const pluginGroups = buildPluginToolGroupsForPolicyEntries({
    entries,
    toolMeta: params.toolMeta,
  });

  let filtered = entries;
  for (const step of params.steps) {
    if (!step.policy) {
      continue;
    }

    let policy: ToolPolicyLike | undefined = step.policy;
    if (step.stripPluginOnlyAllowlist) {
      const resolved = analyzeAllowlistByToolType(policy, pluginGroups, coreToolNames);
      if (resolved.unknownAllowlist.length > 0) {
        const unavailableCoreWarningAllowlist = new Set(
          (step.suppressUnavailableCoreToolWarningAllowlist ?? []).map((entry) =>
            normalizeToolName(entry),
          ),
        );
        const gatedCoreEntries = resolved.unknownAllowlist.filter((entry) =>
          isKnownCoreToolId(entry),
        );
        const warnableGatedCoreEntries = step.suppressUnavailableCoreToolWarning
          ? []
          : gatedCoreEntries.filter((entry) => !unavailableCoreWarningAllowlist.has(entry));
        const otherEntries = resolved.unknownAllowlist.filter(
          (entry) => !isKnownCoreToolId(entry) && !unavailableCoreWarningAllowlist.has(entry),
        );
        const warningEntries = [...warnableGatedCoreEntries, ...otherEntries];
        if (
          shouldWarnAboutUnknownAllowlist({
            hasGatedCoreEntries: warnableGatedCoreEntries.length > 0,
            hasOtherEntries: otherEntries.length > 0,
          })
        ) {
          const warningEntryText = warningEntries.join(", ");
          const suffix = describeUnknownAllowlistSuffix({
            pluginOnlyAllowlist: resolved.pluginOnlyAllowlist,
            hasGatedCoreEntries: warnableGatedCoreEntries.length > 0,
            hasOtherEntries: otherEntries.length > 0,
            unavailableCoreToolReason: step.unavailableCoreToolReason,
          });
          const warning = `tools: ${step.label} allowlist contains unknown entries (${warningEntryText}). ${suffix}`;
          if (rememberToolPolicyWarning(warning)) {
            params.warn(warning);
          }
        }
      }
      policy = resolved.policy;
    }

    const expanded = expandPolicyWithPluginGroups(policy, pluginGroups);
    if (!expanded) {
      continue;
    }
    const before = filtered;
    filtered = filterPolicyEntriesByPolicy(before, expanded);
    auditToolPolicyFilter({
      stepLabel: step.label,
      policy: expanded,
      before: policyAuditTools(before),
      after: policyAuditTools(filtered),
      logLevel: params.auditLogLevel,
    });
  }
  return filtered.map((entry) => entry.tool);
}

function shouldWarnAboutUnknownAllowlist(params: {
  hasGatedCoreEntries: boolean;
  hasOtherEntries: boolean;
}): boolean {
  return params.hasGatedCoreEntries || params.hasOtherEntries;
}

function describeUnknownAllowlistSuffix(params: {
  pluginOnlyAllowlist: boolean;
  hasGatedCoreEntries: boolean;
  hasOtherEntries: boolean;
  unavailableCoreToolReason?: string;
}): string {
  const preface = params.pluginOnlyAllowlist
    ? "Allowlist contains only plugin entries; core tools will not be available."
    : "";
  const unavailableCoreToolReason = params.unavailableCoreToolReason?.trim();
  const unavailableCoreDetail = unavailableCoreToolReason
    ? `These entries are shipped core tools but unavailable here: ${unavailableCoreToolReason}.`
    : "These entries are shipped core tools but unavailable in the current runtime/provider/model/config.";
  const mixedUnavailableCoreDetail = unavailableCoreToolReason
    ? `Some entries are shipped core tools but unavailable here: ${unavailableCoreToolReason}; other entries won't match any tool unless the plugin is enabled.`
    : "Some entries are shipped core tools but unavailable in the current runtime/provider/model/config; other entries won't match any tool unless the plugin is enabled.";
  const detail =
    params.hasGatedCoreEntries && params.hasOtherEntries
      ? mixedUnavailableCoreDetail
      : params.hasGatedCoreEntries
        ? unavailableCoreDetail
        : "These entries won't match any tool unless the plugin is enabled.";
  return preface ? `${preface} ${detail}` : detail;
}

export function resetToolPolicyWarningCacheForTest(): void {
  seenToolPolicyWarnings.clear();
  toolPolicyWarningOrder.length = 0;
}
