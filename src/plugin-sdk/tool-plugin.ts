import { Type, type Static, type TSchema } from "typebox";
import type { AgentToolResult, AgentToolUpdateCallback } from "../agents/runtime/index.js";
import { jsonResult, textResult } from "../agents/tools/common.js";
import type { PluginManifestActivation } from "../plugins/manifest.js";
import type { JsonSchemaObject } from "../shared/json-schema.types.js";
import {
  buildJsonPluginConfigSchema,
  definePluginEntry,
  type AnyAgentTool,
  type OpenClawPluginApi,
  type OpenClawPluginToolContext,
} from "./plugin-entry.js";

const EMPTY_TOOL_PLUGIN_CONFIG_SCHEMA = Type.Object({}, { additionalProperties: false });

export const toolPluginMetadataSymbol = Symbol.for("openclaw.plugin-sdk.tool-plugin.metadata");

export type ToolPluginExecutionContext = {
  api: OpenClawPluginApi;
  signal?: AbortSignal;
  toolCallId: string;
  onUpdate?: AgentToolUpdateCallback;
};

type ToolPluginConfig<TConfigSchema extends TSchema | undefined> = TConfigSchema extends TSchema
  ? Static<TConfigSchema>
  : Record<string, never>;

type ToolPluginToolFactory<TConfig> = <TParamsSchema extends TSchema>(
  definition: ToolPluginToolDefinition<TConfig, TParamsSchema>,
) => DefinedToolPluginTool;

export type ToolPluginFactoryContext<TConfig> = {
  api: OpenClawPluginApi;
  config: TConfig;
  toolContext: OpenClawPluginToolContext;
};

type ToolPluginToolDefinitionBase<TParamsSchema extends TSchema> = {
  name: string;
  label?: string;
  description: string;
  parameters: TParamsSchema;
  optional?: boolean;
};

export type ToolPluginToolDefinition<
  TConfig,
  TParamsSchema extends TSchema,
> = ToolPluginToolDefinitionBase<TParamsSchema> &
  (
    | {
        execute: (
          params: Static<TParamsSchema>,
          config: TConfig,
          context: ToolPluginExecutionContext,
        ) => unknown;
        factory?: never;
      }
    | {
        factory: (
          context: ToolPluginFactoryContext<TConfig>,
        ) => AnyAgentTool | AnyAgentTool[] | null | undefined;
        execute?: never;
      }
  );

type DefinedToolPluginTool = {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  optional: boolean;
  execute?: (params: unknown, config: unknown, context: ToolPluginExecutionContext) => unknown;
  factory?: (
    context: ToolPluginFactoryContext<unknown>,
  ) => AnyAgentTool | AnyAgentTool[] | null | undefined;
};

export type ToolPluginStaticToolMetadata = {
  name: string;
  label: string;
  description: string;
  parameters: JsonSchemaObject;
  optional?: boolean;
};

export type ToolPluginMetadata = {
  id: string;
  name: string;
  description: string;
  activation: PluginManifestActivation;
  configSchema: JsonSchemaObject;
  tools: ToolPluginStaticToolMetadata[];
};

export type DefineToolPluginOptions<TConfigSchema extends TSchema | undefined = undefined> = {
  id: string;
  name: string;
  description: string;
  activation?: PluginManifestActivation;
  configSchema?: TConfigSchema;
  tools: (
    tool: ToolPluginToolFactory<ToolPluginConfig<TConfigSchema>>,
  ) => readonly DefinedToolPluginTool[];
};

export type DefinedToolPluginEntry = ReturnType<typeof definePluginEntry> & {
  [toolPluginMetadataSymbol]: ToolPluginMetadata;
};

function wrapToolPluginResult(result: unknown): AgentToolResult<unknown> {
  if (typeof result === "string") {
    return textResult(result, result);
  }
  return jsonResult(result);
}

function createToolPluginToolFactory<TConfig>(): ToolPluginToolFactory<TConfig> {
  return ((definition: ToolPluginToolDefinition<TConfig, TSchema>) =>
    normalizeDefinedToolPluginTool(definition)) as ToolPluginToolFactory<TConfig>;
}

function normalizeDefinedToolPluginTool(tool: unknown): DefinedToolPluginTool {
  const definition = readToolPluginToolObject(tool);
  const name = readToolPluginToolName(definition);
  const label = readOptionalToolPluginToolLabel(definition, name);
  const description = readToolPluginRequiredString(definition, "description");
  const parameters = readToolPluginParameters(definition);
  const optional = readToolPluginOptionalFlag(definition);
  return {
    name,
    label,
    description,
    parameters,
    optional,
    execute: readToolPluginOptionalFunction(definition, "execute") as
      | DefinedToolPluginTool["execute"]
      | undefined,
    factory: readToolPluginOptionalFunction(definition, "factory") as
      | DefinedToolPluginTool["factory"]
      | undefined,
  };
}

function readToolPluginToolObject(definition: unknown): object {
  if (!definition || typeof definition !== "object") {
    throw new Error("tool plugin tool definition must be an object");
  }
  return definition;
}

function readToolPluginToolName(definition: object): string {
  let name: unknown;
  try {
    name = Reflect.get(definition, "name");
  } catch (cause) {
    throw new Error("tool plugin tool name must be readable", { cause });
  }
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("tool plugin tool name must be a non-empty string");
  }
  return name;
}

function readOptionalToolPluginToolLabel(definition: object, fallback: string): string {
  const label = readToolPluginProperty(definition, "label");
  if (label === undefined) {
    return fallback;
  }
  if (typeof label !== "string") {
    throw new Error("tool plugin tool label must be a string");
  }
  return label;
}

function readToolPluginRequiredString(definition: object, key: string): string {
  const value = readToolPluginProperty(definition, key);
  if (typeof value !== "string") {
    throw new Error(`tool plugin tool ${key} must be a string`);
  }
  return value;
}

function readToolPluginParameters(definition: object): TSchema {
  const parameters = readToolPluginProperty(definition, "parameters");
  if (!parameters || typeof parameters !== "object") {
    throw new Error("tool plugin tool parameters must be an object");
  }
  return parameters as TSchema;
}

function readToolPluginOptionalFlag(definition: object): boolean {
  const optional = readToolPluginProperty(definition, "optional");
  if (optional === undefined) {
    return false;
  }
  if (typeof optional !== "boolean") {
    throw new Error("tool plugin tool optional flag must be a boolean");
  }
  return optional;
}

function readToolPluginOptionalFunction(definition: object, key: string): unknown {
  const value = readToolPluginProperty(definition, key);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "function") {
    throw new Error(`tool plugin tool ${key} must be a function`);
  }
  return value;
}

function readToolPluginProperty(definition: object, key: string): unknown {
  try {
    return Reflect.get(definition, key);
  } catch (cause) {
    throw new Error(`tool plugin tool ${key} must be readable`, { cause });
  }
}

export function defineToolPlugin<TConfigSchema extends TSchema | undefined = undefined>(
  definition: DefineToolPluginOptions<TConfigSchema>,
): DefinedToolPluginEntry {
  const configSchema = (definition.configSchema ??
    EMPTY_TOOL_PLUGIN_CONFIG_SCHEMA) as JsonSchemaObject;
  const pluginConfigSchema = buildJsonPluginConfigSchema(configSchema);
  const normalizedConfigSchema = pluginConfigSchema.jsonSchema ?? configSchema;
  const tools = [
    ...definition.tools(createToolPluginToolFactory<ToolPluginConfig<TConfigSchema>>()),
  ].map(normalizeDefinedToolPluginTool);
  const activation = definition.activation ?? { onStartup: true };
  const metadata: ToolPluginMetadata = {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    activation,
    configSchema: normalizedConfigSchema,
    tools: tools.map((tool) => ({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters as JsonSchemaObject,
      ...(tool.optional ? { optional: true } : {}),
    })),
  };

  const entry = definePluginEntry({
    id: definition.id,
    name: definition.name,
    description: definition.description,
    configSchema: pluginConfigSchema,
    register(api) {
      const config = (api.pluginConfig ?? {}) as ToolPluginConfig<TConfigSchema>;
      for (const tool of tools) {
        const opts = {
          name: tool.name,
          ...(tool.optional ? { optional: true } : {}),
        };
        if (tool.factory) {
          api.registerTool(
            (toolContext) =>
              tool.factory?.({
                api,
                config,
                toolContext,
              }),
            opts,
          );
          continue;
        }
        const execute = tool.execute;
        if (!execute) {
          throw new Error(`tool plugin tool ${tool.name} must define execute or factory`);
        }
        api.registerTool(
          {
            name: tool.name,
            label: tool.label,
            description: tool.description,
            parameters: tool.parameters,
            execute: async (toolCallId, params, signal, onUpdate) =>
              wrapToolPluginResult(
                await execute(params, config, {
                  api,
                  signal,
                  toolCallId,
                  onUpdate,
                }),
              ),
          },
          tool.optional ? { optional: true } : undefined,
        );
      }
    },
  }) as DefinedToolPluginEntry;

  Object.defineProperty(entry, toolPluginMetadataSymbol, {
    value: metadata,
    enumerable: false,
  });
  return entry;
}

export function getToolPluginMetadata(entry: unknown): ToolPluginMetadata | undefined {
  if (!entry || typeof entry !== "object") {
    return undefined;
  }
  const metadata = (entry as { [toolPluginMetadataSymbol]?: unknown })[toolPluginMetadataSymbol];
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }
  return metadata as ToolPluginMetadata;
}
