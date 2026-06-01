import type { CodexDynamicToolSpec, JsonValue } from "./protocol.js";

export function readCodexDynamicToolName(tool: CodexDynamicToolSpec): string | undefined {
  try {
    const name = tool.name;
    return typeof name === "string" && name.trim() ? name.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function readCodexDynamicToolDescription(tool: CodexDynamicToolSpec): string {
  try {
    const description = tool.description;
    return typeof description === "string" ? description.trim() : "";
  } catch {
    return "";
  }
}

export function readCodexDynamicToolInputSchema(tool: CodexDynamicToolSpec): JsonValue | undefined {
  try {
    return tool.inputSchema;
  } catch {
    return undefined;
  }
}

export function isDeferredCodexDynamicTool(tool: CodexDynamicToolSpec): boolean {
  try {
    return tool.deferLoading === true;
  } catch {
    return false;
  }
}
