import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { TSchema } from "typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { defaultRuntime } from "../../runtime.js";
import { normalizeAnyChannelId } from "../registry.js";
import { getChannelPlugin, getLoadedChannelPlugin, listChannelPlugins } from "./index.js";
import type { ChannelMessageCapability } from "./message-capabilities.js";
import {
  resolveBundledChannelMessageToolDiscoveryAdapter,
  type ChannelMessageToolDiscoveryAdapter,
} from "./message-tool-api.js";
import type {
  ChannelMessageActionDiscoveryContext,
  ChannelMessageActionName,
  ChannelMessageToolDiscovery,
  ChannelMessageToolSchemaContribution,
} from "./types.public.js";

export type ChannelMessageActionDiscoveryInput = {
  cfg?: OpenClawConfig;
  channel?: string | null;
  currentChannelProvider?: string | null;
  currentChannelId?: string | null;
  currentThreadTs?: string | null;
  currentMessageId?: string | number | null;
  accountId?: string | null;
  sessionKey?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  requesterSenderId?: string | null;
  senderIsOwner?: boolean;
};

type ChannelMessageActionDiscoveryParams = ChannelMessageActionDiscoveryInput & {
  cfg: OpenClawConfig;
};

type ChannelMessageToolMediaSourceParamKeyInput = ChannelMessageActionDiscoveryParams & {
  action?: ChannelMessageActionName;
};

const loggedMessageActionErrors = new Set<string>();

export function resolveMessageActionDiscoveryChannelId(raw?: string | null): string | undefined {
  return normalizeAnyChannelId(raw) ?? normalizeOptionalString(raw);
}

export function createMessageActionDiscoveryContext(
  params: ChannelMessageActionDiscoveryInput,
): ChannelMessageActionDiscoveryContext {
  const currentChannelProvider = resolveMessageActionDiscoveryChannelId(
    params.channel ?? params.currentChannelProvider,
  );
  return {
    cfg: params.cfg ?? ({} as OpenClawConfig),
    currentChannelId: params.currentChannelId,
    currentChannelProvider,
    currentThreadTs: params.currentThreadTs,
    currentMessageId: params.currentMessageId,
    accountId: params.accountId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId,
    requesterSenderId: params.requesterSenderId,
    senderIsOwner: params.senderIsOwner,
  };
}

function logMessageActionError(params: {
  pluginId: string;
  operation: "describeMessageTool";
  error: unknown;
}) {
  const message = formatErrorMessage(params.error);
  const key = `${params.pluginId}:${params.operation}:${message}`;
  if (loggedMessageActionErrors.has(key)) {
    return;
  }
  loggedMessageActionErrors.add(key);
  const stack = params.error instanceof Error && params.error.stack ? params.error.stack : null;
  defaultRuntime.error?.(
    `[message-action-discovery] ${params.pluginId}.actions.${params.operation} failed: ${stack ?? message}`,
  );
}

function describeMessageToolSafely(params: {
  pluginId: string;
  context: ChannelMessageActionDiscoveryContext;
  describeMessageTool: NonNullable<ChannelMessageToolDiscoveryAdapter["describeMessageTool"]>;
}): ChannelMessageToolDiscovery | null {
  try {
    return params.describeMessageTool(params.context) ?? null;
  } catch (error) {
    logMessageActionError({
      pluginId: params.pluginId,
      operation: "describeMessageTool",
      error,
    });
    return null;
  }
}

function normalizeToolSchemaContributions(
  value:
    | ChannelMessageToolSchemaContribution
    | ChannelMessageToolSchemaContribution[]
    | null
    | undefined,
): ChannelMessageToolSchemaContribution[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function readMessageToolDiscoveryField<K extends keyof ChannelMessageToolDiscovery>(params: {
  pluginId: string;
  described: ChannelMessageToolDiscovery | null;
  field: K;
}): ChannelMessageToolDiscovery[K] | undefined {
  // Plugin discovery can return getter/proxy-backed objects; one bad field
  // must not poison the shared message tool schema for healthy plugins.
  try {
    return params.described?.[params.field];
  } catch (error) {
    logMessageActionError({
      pluginId: params.pluginId,
      operation: "describeMessageTool",
      error,
    });
    return undefined;
  }
}

type ResolvedChannelMessageActionDiscovery = {
  actions: ChannelMessageActionName[];
  capabilities: readonly ChannelMessageCapability[];
  schemaContributions: ChannelMessageToolSchemaContribution[];
  mediaSourceParams: readonly string[];
};

type MessageToolMediaSourceParamMap = Partial<Record<ChannelMessageActionName, readonly string[]>>;

function readSchemaContributionField<K extends keyof ChannelMessageToolSchemaContribution>(params: {
  pluginId: string;
  contribution: ChannelMessageToolSchemaContribution;
  field: K;
}): ChannelMessageToolSchemaContribution[K] | undefined {
  try {
    return params.contribution[params.field];
  } catch (error) {
    logMessageActionError({
      pluginId: params.pluginId,
      operation: "describeMessageTool",
      error,
    });
    return undefined;
  }
}

function normalizeMessageToolMediaSourceParams(params: {
  pluginId: string;
  mediaSourceParams: ChannelMessageToolDiscovery["mediaSourceParams"];
  action?: ChannelMessageActionName;
}): readonly string[] {
  const { mediaSourceParams } = params;
  if (Array.isArray(mediaSourceParams)) {
    return mediaSourceParams;
  }
  if (!mediaSourceParams || typeof mediaSourceParams !== "object") {
    return [];
  }
  const scopedMediaSourceParams = mediaSourceParams as MessageToolMediaSourceParamMap;
  try {
    if (params.action) {
      const scoped = scopedMediaSourceParams[params.action];
      return Array.isArray(scoped) ? scoped : [];
    }
    return Object.values(scopedMediaSourceParams).flatMap((scoped) =>
      Array.isArray(scoped) ? scoped : [],
    );
  } catch (error) {
    logMessageActionError({
      pluginId: params.pluginId,
      operation: "describeMessageTool",
      error,
    });
    return [];
  }
}

export function resolveCurrentChannelMessageToolDiscoveryAdapter(channel?: string | null): {
  pluginId: string;
  actions: ChannelMessageToolDiscoveryAdapter;
} | null {
  const channelId = resolveMessageActionDiscoveryChannelId(channel);
  if (!channelId) {
    return null;
  }
  const loadedPlugin = getLoadedChannelPlugin(channelId as Parameters<typeof getChannelPlugin>[0]);
  if (loadedPlugin?.actions) {
    return {
      pluginId: loadedPlugin.id,
      actions: loadedPlugin.actions,
    };
  }
  const bundledActions = resolveBundledChannelMessageToolDiscoveryAdapter(channelId);
  if (bundledActions) {
    return {
      pluginId: channelId,
      actions: bundledActions,
    };
  }
  const plugin = getChannelPlugin(channelId as Parameters<typeof getChannelPlugin>[0]);
  if (!plugin?.actions) {
    return null;
  }
  return {
    pluginId: plugin.id,
    actions: plugin.actions,
  };
}

export function resolveMessageActionDiscoveryForPlugin(params: {
  pluginId: string;
  actions?: ChannelMessageToolDiscoveryAdapter;
  context: ChannelMessageActionDiscoveryContext;
  action?: ChannelMessageActionName;
  includeActions?: boolean;
  includeCapabilities?: boolean;
  includeSchema?: boolean;
}): ResolvedChannelMessageActionDiscovery {
  const adapter = params.actions;
  if (!adapter) {
    return {
      actions: [],
      capabilities: [],
      schemaContributions: [],
      mediaSourceParams: [],
    };
  }

  const described = describeMessageToolSafely({
    pluginId: params.pluginId,
    context: params.context,
    describeMessageTool: adapter.describeMessageTool,
  });
  const actions = params.includeActions
    ? readMessageToolDiscoveryField({ pluginId: params.pluginId, described, field: "actions" })
    : undefined;
  const capabilities = params.includeCapabilities
    ? readMessageToolDiscoveryField({
        pluginId: params.pluginId,
        described,
        field: "capabilities",
      })
    : undefined;
  const schema = params.includeSchema
    ? readMessageToolDiscoveryField({ pluginId: params.pluginId, described, field: "schema" })
    : undefined;
  const mediaSourceParams = readMessageToolDiscoveryField({
    pluginId: params.pluginId,
    described,
    field: "mediaSourceParams",
  });
  return {
    actions: Array.isArray(actions) ? [...actions] : [],
    capabilities: Array.isArray(capabilities) ? capabilities : [],
    schemaContributions: normalizeToolSchemaContributions(schema),
    mediaSourceParams: normalizeMessageToolMediaSourceParams({
      pluginId: params.pluginId,
      mediaSourceParams,
      action: params.action,
    }),
  };
}

export function listChannelMessageActions(cfg: OpenClawConfig): ChannelMessageActionName[] {
  const actions = new Set<ChannelMessageActionName>(["send", "broadcast"]);
  for (const plugin of listChannelPlugins()) {
    for (const action of resolveMessageActionDiscoveryForPlugin({
      pluginId: plugin.id,
      actions: plugin.actions,
      context: { cfg },
      includeActions: true,
    }).actions) {
      actions.add(action);
    }
  }
  return Array.from(actions);
}

export function listCrossChannelSchemaSupportedMessageActions(
  params: ChannelMessageActionDiscoveryParams & {
    channel?: string;
  },
): ChannelMessageActionName[] {
  const channelId = resolveMessageActionDiscoveryChannelId(params.channel);
  if (!channelId) {
    return [];
  }
  const pluginActions = resolveCurrentChannelMessageToolDiscoveryAdapter(channelId);
  if (!pluginActions?.actions) {
    return [];
  }
  const resolved = resolveMessageActionDiscoveryForPlugin({
    pluginId: pluginActions.pluginId,
    actions: pluginActions.actions,
    context: createMessageActionDiscoveryContext(params),
    includeActions: true,
    includeSchema: true,
  });
  const schemaBlockedActions = new Set<ChannelMessageActionName>();
  for (const contribution of resolved.schemaContributions) {
    const visibility =
      readSchemaContributionField({
        pluginId: pluginActions.pluginId,
        contribution,
        field: "visibility",
      }) ?? "current-channel";
    if (visibility !== "current-channel") {
      continue;
    }
    let hasActions: boolean;
    try {
      hasActions = Object.hasOwn(contribution, "actions");
    } catch (error) {
      logMessageActionError({
        pluginId: pluginActions.pluginId,
        operation: "describeMessageTool",
        error,
      });
      return [];
    }
    if (!hasActions) {
      return [];
    }
    const actions = readSchemaContributionField({
      pluginId: pluginActions.pluginId,
      contribution,
      field: "actions",
    });
    if (!Array.isArray(actions)) {
      return [];
    }
    if (actions.length === 0) {
      continue;
    }
    for (const action of actions) {
      schemaBlockedActions.add(action);
    }
  }
  return resolved.actions.filter((action) => !schemaBlockedActions.has(action));
}

export function listChannelMessageCapabilities(cfg: OpenClawConfig): ChannelMessageCapability[] {
  const capabilities = new Set<ChannelMessageCapability>();
  for (const plugin of listChannelPlugins()) {
    for (const capability of resolveMessageActionDiscoveryForPlugin({
      pluginId: plugin.id,
      actions: plugin.actions,
      context: { cfg },
      includeCapabilities: true,
    }).capabilities) {
      capabilities.add(capability);
    }
  }
  return Array.from(capabilities);
}

export function listChannelMessageCapabilitiesForChannel(
  params: ChannelMessageActionDiscoveryParams,
): ChannelMessageCapability[] {
  const pluginActions = resolveCurrentChannelMessageToolDiscoveryAdapter(params.channel);
  if (!pluginActions) {
    return [];
  }
  return Array.from(
    resolveMessageActionDiscoveryForPlugin({
      pluginId: pluginActions.pluginId,
      actions: pluginActions.actions,
      context: createMessageActionDiscoveryContext(params),
      includeCapabilities: true,
    }).capabilities,
  );
}

function mergeToolSchemaProperties(params: {
  pluginId: string;
  target: Record<string, TSchema>;
  contribution: ChannelMessageToolSchemaContribution;
}) {
  const source = readSchemaContributionField({
    pluginId: params.pluginId,
    contribution: params.contribution,
    field: "properties",
  });
  if (!source) {
    return;
  }
  try {
    for (const [name, schema] of Object.entries(source)) {
      if (!(name in params.target)) {
        params.target[name] = schema;
      }
    }
  } catch (error) {
    logMessageActionError({
      pluginId: params.pluginId,
      operation: "describeMessageTool",
      error,
    });
  }
}

export function resolveChannelMessageToolSchemaProperties(
  params: ChannelMessageActionDiscoveryParams,
): Record<string, TSchema> {
  const properties: Record<string, TSchema> = {};
  const currentChannel = resolveMessageActionDiscoveryChannelId(params.channel);
  const discoveryBase = createMessageActionDiscoveryContext(params);
  const seenPluginIds = new Set<string>();

  for (const plugin of listChannelPlugins()) {
    if (!plugin.actions) {
      continue;
    }
    seenPluginIds.add(plugin.id);
    for (const contribution of resolveMessageActionDiscoveryForPlugin({
      pluginId: plugin.id,
      actions: plugin.actions,
      context: discoveryBase,
      includeSchema: true,
    }).schemaContributions) {
      const visibility =
        readSchemaContributionField({
          pluginId: plugin.id,
          contribution,
          field: "visibility",
        }) ?? "current-channel";
      if (currentChannel) {
        if (visibility === "all-configured" || plugin.id === currentChannel) {
          mergeToolSchemaProperties({
            pluginId: plugin.id,
            target: properties,
            contribution,
          });
        }
        continue;
      }
      mergeToolSchemaProperties({
        pluginId: plugin.id,
        target: properties,
        contribution,
      });
    }
  }
  if (currentChannel && !seenPluginIds.has(currentChannel)) {
    const currentActions = resolveCurrentChannelMessageToolDiscoveryAdapter(currentChannel);
    if (currentActions?.actions) {
      for (const contribution of resolveMessageActionDiscoveryForPlugin({
        pluginId: currentActions.pluginId,
        actions: currentActions.actions,
        context: discoveryBase,
        includeSchema: true,
      }).schemaContributions) {
        const visibility =
          readSchemaContributionField({
            pluginId: currentActions.pluginId,
            contribution,
            field: "visibility",
          }) ?? "current-channel";
        if (visibility === "all-configured" || currentActions.pluginId === currentChannel) {
          mergeToolSchemaProperties({
            pluginId: currentActions.pluginId,
            target: properties,
            contribution,
          });
        }
      }
    }
  }

  return properties;
}

export function resolveChannelMessageToolMediaSourceParamKeys(
  params: ChannelMessageToolMediaSourceParamKeyInput,
): string[] {
  const pluginActions = resolveCurrentChannelMessageToolDiscoveryAdapter(params.channel);
  if (!pluginActions) {
    return [];
  }
  const described = resolveMessageActionDiscoveryForPlugin({
    pluginId: pluginActions.pluginId,
    actions: pluginActions.actions,
    context: createMessageActionDiscoveryContext(params),
    action: params.action,
    includeSchema: false,
  });
  return uniqueStrings(described.mediaSourceParams);
}

export function channelSupportsMessageCapability(
  cfg: OpenClawConfig,
  capability: ChannelMessageCapability,
): boolean {
  return listChannelMessageCapabilities(cfg).includes(capability);
}

export function channelSupportsMessageCapabilityForChannel(
  params: ChannelMessageActionDiscoveryParams,
  capability: ChannelMessageCapability,
): boolean {
  return listChannelMessageCapabilitiesForChannel(params).includes(capability);
}

export const testing = {
  resetLoggedMessageActionErrors() {
    loggedMessageActionErrors.clear();
  },
};
export { testing as __testing };
