import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleepTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  normalizeOptionalString,
  readStringValue,
  uniqueStrings,
  uniqueValues,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatErrorMessage } from "../infra/errors.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { redactToolPayloadText } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { asRecord } from "../record-shared.js";
import { redactCdpUrl } from "./cdp.helpers.js";
import type { ChromeMcpSnapshotNode } from "./chrome-mcp.snapshot.js";
import type { BrowserTab } from "./client.types.js";
import type {
  ResolvedBrowserChromeMcpCapabilities,
  ResolvedBrowserChromeMcpConfig,
} from "./config.js";
import { BrowserProfileUnavailableError, BrowserTabNotFoundError } from "./errors.js";

const log = createSubsystemLogger("browser").child("chrome-mcp");

type ChromeMcpStructuredPage = {
  id: number;
  url?: string;
  selected?: boolean;
};

export type ChromeMcpConsoleMessage = {
  id?: number;
  type?: string;
  text?: string;
  argsCount?: number;
  args?: unknown[];
  stackTrace?: string;
};

export type ChromeMcpNetworkRequest = {
  requestId?: number;
  id?: string;
  method?: string;
  url?: string;
  status?: string;
  selectedInDevToolsUI?: boolean;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
};

export type ChromeMcpPagination = {
  currentPage?: number;
  totalPages?: number;
  hasNextPage?: boolean;
  hasPreviousPage?: boolean;
  startIndex?: number;
  endIndex?: number;
  invalidPage?: boolean;
};

export type ChromeMcpConsoleMessagesResult = {
  messages: ChromeMcpConsoleMessage[];
  pagination?: ChromeMcpPagination;
};

export type ChromeMcpNetworkRequestsResult = {
  requests: ChromeMcpNetworkRequest[];
  pagination?: ChromeMcpPagination;
};

export type ChromeMcpExtension = {
  id?: string;
  name?: string;
  version?: string;
  enabled?: boolean;
  path?: string;
  [key: string]: unknown;
};

export type ChromeMcpGenericToolResult = {
  output: string;
  structuredContent?: Record<string, unknown>;
};

type ChromeMcpToolResult = {
  structuredContent?: Record<string, unknown>;
  content?: Array<Record<string, unknown>>;
  isError?: boolean;
};

type ChromeMcpSession = {
  client: Client;
  transport: StdioClientTransport;
  ready: Promise<void>;
  ownsProcessTree?: boolean;
  options?: NormalizedChromeMcpProfileOptions;
};

type ChromeMcpCallOptions = {
  ephemeral?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type ChromeMcpProfileOptions = {
  userDataDir?: string;
  cdpUrl?: string;
  executablePath?: string;
  headless?: boolean;
  noSandbox?: boolean;
  cleanupBrowserProcesses?: boolean;
  chromeMcp?: ResolvedBrowserChromeMcpConfig;
  mcpCommand?: string;
  mcpArgs?: string[];
};

type NormalizedChromeMcpProfileOptions = {
  userDataDir?: string;
  browserUrl?: string;
  executablePath?: string;
  headless?: boolean;
  noSandbox?: boolean;
  cleanupBrowserProcesses?: boolean;
  chromeMcp?: ResolvedBrowserChromeMcpConfig;
  command: string;
  extraArgs: string[];
};
type ChromeMcpOptionsInput = string | ChromeMcpProfileOptions | NormalizedChromeMcpProfileOptions;

type ChromeMcpSessionLease = {
  session: ChromeMcpSession;
  cacheKey: string;
  temporary: boolean;
};

type ChromeMcpSessionFactory = (
  profileName: string,
  options?: NormalizedChromeMcpProfileOptions,
) => Promise<ChromeMcpSession>;

export type ChromeMcpProcessInfo = {
  pid: number;
  ppid: number;
};

export type ChromeMcpProcessCleanupDeps = {
  listProcesses?: () => Promise<ChromeMcpProcessInfo[]>;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  platform?: NodeJS.Platform;
  taskkillProcessTree?: (pid: number) => Promise<void>;
};

const DEFAULT_CHROME_MCP_COMMAND = "npx";
const DEFAULT_CHROME_MCP_PACKAGE_ARGS = ["-y", "chrome-devtools-mcp@latest"];
const DEFAULT_CHROME_MCP_BASE_FEATURE_ARGS = [
  "--no-usage-statistics",
  // Direct chrome-devtools-mcp launches do not enable structuredContent by default.
  "--experimentalStructuredContent",
  "--experimental-page-id-routing",
  // Enables Chrome DevTools MCP's coordinate-based click_at tool for OpenClaw clickCoords.
  "--experimentalVision",
];
const DEFAULT_CHROME_MCP_DIAGNOSTIC_FEATURE_ARGS = [
  // Enables Chrome DevTools MCP heap snapshot inspection tools.
  "--experimentalMemory",
  // Enables Chrome DevTools MCP screencast_start/stop tools.
  "--experimentalScreencast",
  // Enables Chrome DevTools MCP get_tab_id interoperability tool.
  "--experimentalInteropTools",
];
const DEFAULT_CHROME_MCP_CATEGORY_FEATURE_ARGS = {
  // Enables Chrome DevTools MCP page-exposed tool listing/execution surfaces.
  thirdPartyTools: "--categoryExperimentalThirdParty",
  webMcpTools: "--categoryExperimentalWebmcp",
  // Enables Chrome DevTools MCP extension inventory/actions when the connected Chrome mode supports it.
  extensions: "--categoryExtensions",
} as const;
const FALLBACK_CHROME_MCP_CAPABILITIES: ResolvedBrowserChromeMcpCapabilities = {
  diagnostics: false,
  extensions: false,
  extensionMutation: false,
  thirdPartyTools: false,
  thirdPartyToolExecution: false,
  webMcpTools: false,
  webMcpToolExecution: false,
};
const CHROME_MCP_USAGE_STATISTICS_FLAG_RE = /^--(?:no-)?usage-?statistics(?:=.*)?$/i;
const CHROME_MCP_POLICY_CONTROLLED_FEATURE_FLAGS = new Set([
  ...DEFAULT_CHROME_MCP_DIAGNOSTIC_FEATURE_ARGS,
  ...Object.values(DEFAULT_CHROME_MCP_CATEGORY_FEATURE_ARGS),
]);
const CHROME_MCP_PROCESS_SCAN_TIMEOUT_MS = 1_000;
const CHROME_MCP_BROWSER_STOP_GRACE_MS = 1_500;

const execFileAsync = promisify(execFile);
const CHROME_MCP_CONNECTION_FLAGS = new Set([
  "--autoConnect",
  "--auto-connect",
  "--browserUrl",
  "--browser-url",
  "--wsEndpoint",
  "--ws-endpoint",
  "--isolated",
  "-w",
]);
const CHROME_MCP_USER_DATA_DIR_FLAGS = new Set(["--userDataDir", "--user-data-dir"]);
const CHROME_MCP_EXECUTABLE_PATH_FLAGS = new Set(["--executablePath", "--executable-path", "-e"]);
const CHROME_MCP_HEADLESS_FLAGS = new Set(["--headless", "--no-headless"]);
const CHROME_MCP_CHROME_ARG_FLAGS = new Set(["--chromeArg", "--chrome-arg"]);
const CHROME_MCP_NEW_PAGE_TIMEOUT_MS = 5_000;
const CHROME_MCP_NAVIGATE_TIMEOUT_MS = 20_000;
const CHROME_MCP_HANDSHAKE_TIMEOUT_MS = 30_000;
const CHROME_MCP_STDERR_MAX_BYTES = 8 * 1024;
const CHROME_MCP_PROCESS_EXIT_GRACE_MS = 250;
const CDP_URL_IN_TEXT_RE = /\b(?:https?|wss?):\/\/[^\s"'<>`]+/gi;
const STALE_SELECTED_PAGE_ERROR =
  "The selected page has been closed. Call list_pages to see open pages.";

type ChromeMcpTrackedEmulationState = {
  networkConditions?: "Offline";
  geolocation?: string;
  colorScheme?: "dark" | "light";
};

const sessions = new Map<string, ChromeMcpSession>();
const pendingSessions = new Map<string, Promise<ChromeMcpSession>>();
const emulationStates = new Map<string, ChromeMcpTrackedEmulationState>();
let sessionFactory: ChromeMcpSessionFactory | null = null;
let chromeMcpProcessCleanupDepsForTest: ChromeMcpProcessCleanupDeps | null = null;

function asPages(value: unknown): ChromeMcpStructuredPage[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: ChromeMcpStructuredPage[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record || typeof record.id !== "number") {
      continue;
    }
    out.push({
      id: record.id,
      url: readStringValue(record.url),
      selected: record.selected === true,
    });
  }
  return out;
}

function parsePageId(targetId: string): number {
  const parsed = Number.parseInt(targetId.trim(), 10);
  if (!Number.isFinite(parsed)) {
    throw new BrowserTabNotFoundError();
  }
  return parsed;
}

function toBrowserTabs(pages: ChromeMcpStructuredPage[]): BrowserTab[] {
  return pages.map((page) => ({
    targetId: String(page.id),
    title: "",
    url: page.url ?? "",
    type: "page",
  }));
}

function extractStructuredContent(result: ChromeMcpToolResult): Record<string, unknown> {
  return asRecord(result.structuredContent) ?? {};
}

function toGenericToolResult(result: ChromeMcpToolResult): ChromeMcpGenericToolResult {
  const structuredContent = extractStructuredContent(result);
  return {
    output: extractMessageText(result),
    ...(Object.keys(structuredContent).length > 0 ? { structuredContent } : {}),
  };
}

function extractTextExtensions(result: ChromeMcpToolResult): ChromeMcpExtension[] {
  const extensions: ChromeMcpExtension[] = [];
  for (const block of extractTextContent(result)) {
    for (const line of block.split(/\r?\n/)) {
      const match = line.match(/\bid=([^\s]+)\s+"([^"]+)"\s+v([^\s]+)(?:\s+(Enabled|Disabled))?/i);
      if (!match) {
        continue;
      }
      extensions.push({
        id: match[1],
        name: match[2],
        version: match[3],
        ...(match[4] ? { enabled: /^enabled$/i.test(match[4]) } : {}),
      });
    }
  }
  return extensions;
}

function extractExtensions(result: ChromeMcpToolResult): ChromeMcpExtension[] {
  const textExtensions = extractTextExtensions(result);
  const extensions = extractStructuredContent(result).extensions;
  if (!Array.isArray(extensions)) {
    return textExtensions;
  }
  const structuredExtensions = extensions
    .map((entry) => asRecord(entry))
    .filter((entry): entry is ChromeMcpExtension => Boolean(entry))
    .filter((entry) => Object.keys(entry).length > 0);
  return structuredExtensions.length > 0 ? structuredExtensions : textExtensions;
}

function extractTextContent(result: ChromeMcpToolResult): string[] {
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .map((entry) => {
      const record = asRecord(entry);
      return record && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean);
}

function extractTextPages(result: ChromeMcpToolResult): ChromeMcpStructuredPage[] {
  const pages: ChromeMcpStructuredPage[] = [];
  for (const block of extractTextContent(result)) {
    for (const line of block.split(/\r?\n/)) {
      const match = line.match(/^\s*(\d+):\s+(.+?)(?:\s+\[(selected)\])?\s*$/i);
      if (!match) {
        continue;
      }
      pages.push({
        id: Number.parseInt(match[1] ?? "", 10),
        url: normalizeOptionalString(match[2]),
        selected: Boolean(match[3]),
      });
    }
  }
  return pages;
}

function extractStructuredPages(result: ChromeMcpToolResult): ChromeMcpStructuredPage[] {
  const structured = asPages(extractStructuredContent(result).pages);
  return structured.length > 0 ? structured : extractTextPages(result);
}

function readNumberValue(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readBooleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readStringRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    const value = readStringValue(entry);
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function readPagination(value: unknown): ChromeMcpPagination | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const pagination: ChromeMcpPagination = {
    ...(readNumberValue(record.currentPage) !== undefined
      ? { currentPage: readNumberValue(record.currentPage) }
      : {}),
    ...(readNumberValue(record.totalPages) !== undefined
      ? { totalPages: readNumberValue(record.totalPages) }
      : {}),
    ...(readBooleanValue(record.hasNextPage) !== undefined
      ? { hasNextPage: readBooleanValue(record.hasNextPage) }
      : {}),
    ...(readBooleanValue(record.hasPreviousPage) !== undefined
      ? { hasPreviousPage: readBooleanValue(record.hasPreviousPage) }
      : {}),
    ...(readNumberValue(record.startIndex) !== undefined
      ? { startIndex: readNumberValue(record.startIndex) }
      : {}),
    ...(readNumberValue(record.endIndex) !== undefined
      ? { endIndex: readNumberValue(record.endIndex) }
      : {}),
    ...(readBooleanValue(record.invalidPage) !== undefined
      ? { invalidPage: readBooleanValue(record.invalidPage) }
      : {}),
  };
  return Object.values(pagination).some((entry) => entry !== undefined) ? pagination : undefined;
}

function readConsoleMessage(value: unknown): ChromeMcpConsoleMessage | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const id = readNumberValue(record.id) ?? readNumberValue(record.msgid);
  return {
    ...(id !== undefined ? { id } : {}),
    ...(readStringValue(record.type) !== undefined ? { type: readStringValue(record.type) } : {}),
    ...(readStringValue(record.text) !== undefined ? { text: readStringValue(record.text) } : {}),
    ...(readNumberValue(record.argsCount) !== undefined
      ? { argsCount: readNumberValue(record.argsCount) }
      : {}),
    ...(Array.isArray(record.args) ? { args: record.args } : {}),
    ...(readStringValue(record.stackTrace) !== undefined
      ? { stackTrace: readStringValue(record.stackTrace) }
      : {}),
  };
}

function extractTextConsoleMessages(result: ChromeMcpToolResult): ChromeMcpConsoleMessage[] {
  const messages: ChromeMcpConsoleMessage[] = [];
  for (const block of extractTextContent(result)) {
    for (const line of block.split(/\r?\n/)) {
      const match = line.match(
        /^\s*msgid=(\d+)\s+\[([^\]]+)]\s+(.+?)(?:\s+\((\d+)\s+args\))?\s*$/i,
      );
      if (!match) {
        continue;
      }
      messages.push({
        id: Number.parseInt(match[1] ?? "", 10),
        type: normalizeOptionalString(match[2]),
        text: normalizeOptionalString(match[3]),
        argsCount: match[4] ? Number.parseInt(match[4], 10) : undefined,
      });
    }
  }
  return messages;
}

function extractConsoleMessages(result: ChromeMcpToolResult): ChromeMcpConsoleMessagesResult {
  const structured = extractStructuredContent(result);
  const rawMessages = Array.isArray(structured.consoleMessages) ? structured.consoleMessages : [];
  const messages = rawMessages
    .map((entry) => readConsoleMessage(entry))
    .filter((entry): entry is ChromeMcpConsoleMessage => entry !== null);
  return {
    messages: messages.length > 0 ? messages : extractTextConsoleMessages(result),
    pagination: readPagination(structured.pagination),
  };
}

function extractConsoleMessage(result: ChromeMcpToolResult): ChromeMcpConsoleMessage | null {
  const structured = extractStructuredContent(result);
  return readConsoleMessage(structured.consoleMessage);
}

function readNetworkRequest(value: unknown): ChromeMcpNetworkRequest | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const requestId = readNumberValue(record.requestId);
  return {
    ...(requestId !== undefined ? { requestId } : {}),
    ...(requestId !== undefined
      ? { id: String(requestId) }
      : readStringValue(record.id) !== undefined
        ? { id: readStringValue(record.id) }
        : {}),
    ...(readStringValue(record.method) !== undefined
      ? { method: readStringValue(record.method) }
      : {}),
    ...(readStringValue(record.url) !== undefined ? { url: readStringValue(record.url) } : {}),
    ...(readStringValue(record.status) !== undefined
      ? { status: readStringValue(record.status) }
      : {}),
    ...(readBooleanValue(record.selectedInDevToolsUI) !== undefined
      ? { selectedInDevToolsUI: readBooleanValue(record.selectedInDevToolsUI) }
      : {}),
    ...(readStringRecord(record.requestHeaders) !== undefined
      ? { requestHeaders: readStringRecord(record.requestHeaders) }
      : {}),
    ...(readStringRecord(record.responseHeaders) !== undefined
      ? { responseHeaders: readStringRecord(record.responseHeaders) }
      : {}),
    ...(readStringValue(record.requestBody) !== undefined
      ? { requestBody: readStringValue(record.requestBody) }
      : {}),
    ...(readStringValue(record.responseBody) !== undefined
      ? { responseBody: readStringValue(record.responseBody) }
      : {}),
  };
}

function extractTextNetworkRequests(result: ChromeMcpToolResult): ChromeMcpNetworkRequest[] {
  const requests: ChromeMcpNetworkRequest[] = [];
  for (const block of extractTextContent(result)) {
    for (const line of block.split(/\r?\n/)) {
      const match = line.match(/^\s*reqid=(\d+)\s+(\S+)\s+(.+?)\s+\[([^\]]+)]\s*$/i);
      if (!match) {
        continue;
      }
      const requestId = Number.parseInt(match[1] ?? "", 10);
      requests.push({
        requestId,
        id: String(requestId),
        method: normalizeOptionalString(match[2]),
        url: normalizeOptionalString(match[3]),
        status: normalizeOptionalString(match[4]),
      });
    }
  }
  return requests;
}

function extractNetworkRequests(result: ChromeMcpToolResult): ChromeMcpNetworkRequestsResult {
  const structured = extractStructuredContent(result);
  const rawRequests = Array.isArray(structured.networkRequests) ? structured.networkRequests : [];
  const requests = rawRequests
    .map((entry) => readNetworkRequest(entry))
    .filter((entry): entry is ChromeMcpNetworkRequest => entry !== null);
  return {
    requests: requests.length > 0 ? requests : extractTextNetworkRequests(result),
    pagination: readPagination(structured.pagination),
  };
}

function extractNetworkRequest(result: ChromeMcpToolResult): ChromeMcpNetworkRequest | null {
  const structured = extractStructuredContent(result);
  return readNetworkRequest(structured.networkRequest);
}

function extractSnapshot(result: ChromeMcpToolResult): ChromeMcpSnapshotNode {
  const structured = extractStructuredContent(result);
  const snapshot = asRecord(structured.snapshot);
  if (!snapshot) {
    throw new Error("Chrome MCP snapshot response was missing structured snapshot data.");
  }
  return snapshot as unknown as ChromeMcpSnapshotNode;
}

function extractJsonBlock(text: string): unknown {
  const match = text.match(/```json\s*([\s\S]*?)\s*```/i);
  const raw = match?.[1]?.trim() || text.trim();
  return raw ? JSON.parse(raw) : null;
}

function extractMessageText(result: ChromeMcpToolResult): string {
  const message = extractStructuredContent(result).message;
  if (typeof message === "string" && message.trim()) {
    return message;
  }
  const blocks = extractTextContent(result);
  return blocks.find((block) => block.trim()) ?? "";
}

function extractToolErrorMessage(result: ChromeMcpToolResult, name: string): string {
  const message = extractMessageText(result).trim();
  return message || `Chrome MCP tool "${name}" failed.`;
}

function shouldReconnectForToolError(name: string, message: string): boolean {
  return name === "list_pages" && message.includes(STALE_SELECTED_PAGE_ERROR);
}

function extractJsonMessage(result: ChromeMcpToolResult): unknown {
  const candidates = [extractMessageText(result), ...extractTextContent(result)].filter((text) =>
    text.trim(),
  );
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return extractJsonBlock(candidate);
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError) {
    throw lastError;
  }
  return null;
}

function normalizeChromeMcpUserDataDir(userDataDir?: string): string | undefined {
  const trimmed = userDataDir?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeChromeMcpStringList(values?: string[]): string[] {
  return Array.isArray(values)
    ? values.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      )
    : [];
}

function normalizeChromeMcpOptions(
  input?: ChromeMcpOptionsInput,
): NormalizedChromeMcpProfileOptions {
  if (typeof input === "object" && input && "command" in input && "extraArgs" in input) {
    return input;
  }
  const options = typeof input === "string" ? { userDataDir: input } : (input ?? {});
  const command = normalizeOptionalString(options.mcpCommand) ?? DEFAULT_CHROME_MCP_COMMAND;
  return {
    command,
    userDataDir: normalizeChromeMcpUserDataDir(options.userDataDir),
    browserUrl: normalizeOptionalString(options.cdpUrl),
    executablePath: normalizeOptionalString(options.executablePath),
    headless: typeof options.headless === "boolean" ? options.headless : undefined,
    noSandbox: options.noSandbox === true,
    cleanupBrowserProcesses: options.cleanupBrowserProcesses === true,
    chromeMcp: options.chromeMcp,
    extraArgs: normalizeChromeMcpStringList(options.mcpArgs),
  };
}

function hasFlag(args: string[], flags: Set<string>): boolean {
  return args.some((arg) => {
    const [name] = arg.split("=", 1);
    return flags.has(name ?? arg);
  });
}

function isChromeMcpWebSocketEndpoint(url: string): boolean {
  return /^wss?:\/\//i.test(url);
}

function isChromeMcpSelectedPageLookupUnavailable(error: unknown): boolean {
  return formatErrorMessage(error).includes("Request not found for selected page");
}

function shouldLaunchChromeMcpBrowser(options: NormalizedChromeMcpProfileOptions): boolean {
  if (options.browserUrl || hasFlag(options.extraArgs, CHROME_MCP_CONNECTION_FLAGS)) {
    return false;
  }
  return Boolean(
    options.executablePath ||
    typeof options.headless === "boolean" ||
    options.noSandbox ||
    hasFlag(options.extraArgs, CHROME_MCP_EXECUTABLE_PATH_FLAGS) ||
    hasFlag(options.extraArgs, CHROME_MCP_HEADLESS_FLAGS) ||
    hasFlag(options.extraArgs, CHROME_MCP_CHROME_ARG_FLAGS),
  );
}

function buildChromeMcpConnectionArgs(options: NormalizedChromeMcpProfileOptions): string[] {
  if (hasFlag(options.extraArgs, CHROME_MCP_CONNECTION_FLAGS)) {
    return [];
  }
  if (options.browserUrl) {
    return isChromeMcpWebSocketEndpoint(options.browserUrl)
      ? ["--wsEndpoint", options.browserUrl]
      : ["--browserUrl", options.browserUrl];
  }
  return shouldLaunchChromeMcpBrowser(options) ? [] : ["--autoConnect"];
}

function hasChromeArgValue(args: string[], value: string): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === value) {
      return true;
    }
    if (arg === "--chromeArg" || arg === "--chrome-arg") {
      if (args[i + 1] === value) {
        return true;
      }
      i++;
      continue;
    }
    if (arg === `--chromeArg=${value}` || arg === `--chrome-arg=${value}`) {
      return true;
    }
  }
  return false;
}

function buildChromeMcpLaunchArgs(options: NormalizedChromeMcpProfileOptions): string[] {
  if (options.browserUrl || hasFlag(options.extraArgs, CHROME_MCP_CONNECTION_FLAGS)) {
    return [];
  }
  const args: string[] = [];
  if (options.executablePath && !hasFlag(options.extraArgs, CHROME_MCP_EXECUTABLE_PATH_FLAGS)) {
    args.push("--executablePath", options.executablePath);
  }
  if (
    typeof options.headless === "boolean" &&
    !hasFlag(options.extraArgs, CHROME_MCP_HEADLESS_FLAGS)
  ) {
    args.push(options.headless ? "--headless" : "--no-headless");
  }
  if (options.noSandbox && !hasChromeArgValue(options.extraArgs, "--no-sandbox")) {
    args.push("--chrome-arg=--no-sandbox");
  }
  return args;
}

function buildChromeMcpUserDataDirArgs(options: NormalizedChromeMcpProfileOptions): string[] {
  if (
    !options.userDataDir ||
    options.browserUrl ||
    hasFlag(options.extraArgs, CHROME_MCP_CONNECTION_FLAGS) ||
    hasFlag(options.extraArgs, CHROME_MCP_USER_DATA_DIR_FLAGS)
  ) {
    return [];
  }
  return ["--userDataDir", options.userDataDir];
}

function buildChromeMcpSessionCacheKey(
  profileName: string,
  options: NormalizedChromeMcpProfileOptions,
): string {
  return JSON.stringify([
    profileName,
    options.userDataDir ?? "",
    options.browserUrl ?? "",
    options.command,
    options.executablePath ?? "",
    typeof options.headless === "boolean" ? String(options.headless) : "",
    options.noSandbox ? "true" : "",
    options.cleanupBrowserProcesses ? "true" : "",
    options.chromeMcp?.capabilities ?? {},
    options.extraArgs,
  ]);
}

function buildChromeMcpPageStateKey(
  profileName: string,
  options: NormalizedChromeMcpProfileOptions,
  targetId: string,
): string {
  return JSON.stringify([
    profileName,
    options.userDataDir ?? "",
    options.browserUrl ?? "",
    options.command,
    options.executablePath ?? "",
    typeof options.headless === "boolean" ? String(options.headless) : "",
    options.noSandbox ? "true" : "",
    options.cleanupBrowserProcesses ? "true" : "",
    options.chromeMcp?.capabilities ?? {},
    options.extraArgs,
    targetId,
  ]);
}

function chromeMcpProfileOptionsFromParams(params: {
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
}): string | ChromeMcpProfileOptions | undefined {
  return params.profile ?? params.userDataDir;
}

function cacheKeyMatchesProfileName(cacheKey: string, profileName: string): boolean {
  try {
    const parsed = JSON.parse(cacheKey);
    return Array.isArray(parsed) && parsed[0] === profileName;
  } catch {
    return false;
  }
}

function pageStateKeyMatchesProfileName(
  stateKey: string,
  profileName: string,
  keepSessionKey?: string,
): boolean {
  try {
    const parsed = JSON.parse(stateKey);
    if (!Array.isArray(parsed) || parsed[0] !== profileName) {
      return false;
    }
    if (!keepSessionKey) {
      return true;
    }
    const keep = JSON.parse(keepSessionKey);
    return !Array.isArray(keep) || JSON.stringify(parsed.slice(0, keep.length)) !== keepSessionKey;
  } catch {
    return false;
  }
}

async function closeChromeMcpSessionsForProfile(
  profileName: string,
  keepKey?: string,
  fallbackOptions?: ChromeMcpOptionsInput,
): Promise<boolean> {
  let closed = false;
  const cleanupOptions: NormalizedChromeMcpProfileOptions[] = [];

  for (const key of Array.from(pendingSessions.keys())) {
    if (key !== keepKey && cacheKeyMatchesProfileName(key, profileName)) {
      pendingSessions.delete(key);
      closed = true;
    }
  }

  for (const [key, session] of Array.from(sessions.entries())) {
    if (key !== keepKey && cacheKeyMatchesProfileName(key, profileName)) {
      sessions.delete(key);
      closed = true;
      await closeChromeMcpSessionHandle(session);
    }
  }

  if (fallbackOptions) {
    cleanupOptions.push(normalizeChromeMcpOptions(fallbackOptions));
  }

  for (const key of Array.from(emulationStates.keys())) {
    if (pageStateKeyMatchesProfileName(key, profileName, keepKey)) {
      emulationStates.delete(key);
    }
  }

  for (const options of dedupeChromeMcpCleanupOptions(cleanupOptions)) {
    const killed = await terminateChromeMcpBrowserProcessesForOptions(options);
    if (killed > 0) {
      closed = true;
    }
  }

  return closed;
}

function dedupeChromeMcpCleanupOptions(
  options: NormalizedChromeMcpProfileOptions[],
): NormalizedChromeMcpProfileOptions[] {
  const seen = new Set<string>();
  const result: NormalizedChromeMcpProfileOptions[] = [];
  for (const option of options) {
    const key = JSON.stringify([
      option.userDataDir ?? "",
      option.browserUrl ?? "",
      option.command,
      option.extraArgs,
      option.cleanupBrowserProcesses === true,
    ]);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(option);
    }
  }
  return result;
}

function shouldCleanupChromeMcpBrowserProcesses(
  options: NormalizedChromeMcpProfileOptions,
): options is NormalizedChromeMcpProfileOptions & { userDataDir: string } {
  if (
    options.cleanupBrowserProcesses !== true ||
    !options.userDataDir ||
    options.browserUrl ||
    hasFlag(options.extraArgs, CHROME_MCP_CONNECTION_FLAGS)
  ) {
    return false;
  }
  const resolved = path.resolve(options.userDataDir);
  if (resolved === path.parse(resolved).root || resolved === path.resolve(os.homedir())) {
    return false;
  }
  return true;
}

function collectChromeMcpBrowserProcessIdsForUserDataDir(
  psOutput: string,
  userDataDir: string,
): number[] {
  const resolvedUserDataDir = path.resolve(userDataDir);
  const needles = [
    `--user-data-dir=${resolvedUserDataDir}`,
    `--userDataDir ${resolvedUserDataDir}`,
    `--userDataDir=${resolvedUserDataDir}`,
  ];
  const pids: number[] = [];
  const includesNeedleAsArg = (command: string, needle: string): boolean => {
    let offset = 0;
    for (;;) {
      const index = command.indexOf(needle, offset);
      if (index < 0) {
        return false;
      }
      const before = index === 0 ? "" : command[index - 1];
      const after = command[index + needle.length] ?? "";
      const beforeOk = before === "" || /\s/.test(before);
      const afterOk = after === "" || /\s/.test(after);
      if (beforeOk && afterOk) {
        return true;
      }
      offset = index + needle.length;
    }
  };
  for (const line of psOutput.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match) {
      continue;
    }
    const pid = Number(match[1]);
    const command = match[2] ?? "";
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
      continue;
    }
    if (needles.some((needle) => includesNeedleAsArg(command, needle))) {
      pids.push(pid);
    }
  }
  return [...new Set(pids)];
}

export function collectChromeMcpBrowserProcessIdsForUserDataDirForTest(
  psOutput: string,
  userDataDir: string,
): number[] {
  return collectChromeMcpBrowserProcessIdsForUserDataDir(psOutput, userDataDir);
}

function collectProcessTreeIdsFromPsOutput(psOutput: string, rootPid: number): number[] {
  if (!Number.isInteger(rootPid) || rootPid <= 0 || rootPid === process.pid) {
    return [];
  }
  const childrenByParent = new Map<number, number[]>();
  for (const line of psOutput.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
    if (!match) {
      continue;
    }
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || pid <= 0 || pid === process.pid) {
      continue;
    }
    const children = childrenByParent.get(ppid) ?? [];
    children.push(pid);
    childrenByParent.set(ppid, children);
  }

  const seen = new Set<number>();
  const result: number[] = [];
  const visit = (pid: number): void => {
    if (seen.has(pid) || pid === process.pid) {
      return;
    }
    seen.add(pid);
    for (const childPid of childrenByParent.get(pid) ?? []) {
      visit(childPid);
    }
    result.push(pid);
  };
  visit(rootPid);
  return result;
}

export function collectChromeMcpProcessTreeIdsForTest(psOutput: string, rootPid: number): number[] {
  return collectProcessTreeIdsFromPsOutput(psOutput, rootPid);
}

async function findChromeMcpBrowserProcessIdsForUserDataDir(
  userDataDir: string,
): Promise<number[]> {
  if (process.platform === "win32") {
    return [];
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-eo", "pid=,args="], {
      encoding: "utf8",
      maxBuffer: 1_000_000,
      timeout: CHROME_MCP_PROCESS_SCAN_TIMEOUT_MS,
    });
    return collectChromeMcpBrowserProcessIdsForUserDataDir(stdout, userDataDir);
  } catch {
    return [];
  }
}

function signalProcesses(pids: number[], signal: NodeJS.Signals): number {
  let count = 0;
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
      count += 1;
    } catch {
      // Process already exited or is unavailable.
    }
  }
  return count;
}

async function terminateChromeMcpBrowserProcessesForOptions(
  options: NormalizedChromeMcpProfileOptions,
): Promise<number> {
  if (!shouldCleanupChromeMcpBrowserProcesses(options)) {
    return 0;
  }
  const pids = await findChromeMcpBrowserProcessIdsForUserDataDir(options.userDataDir);
  const signaled = signalProcesses(pids, "SIGTERM");
  if (signaled === 0) {
    return 0;
  }
  await new Promise((resolve) => setTimeout(resolve, CHROME_MCP_BROWSER_STOP_GRACE_MS));
  const remaining = await findChromeMcpBrowserProcessIdsForUserDataDir(options.userDataDir);
  signalProcesses(remaining, "SIGKILL");
  return signaled;
}

function resolveChromeMcpCapabilities(
  options: NormalizedChromeMcpProfileOptions,
): ResolvedBrowserChromeMcpCapabilities {
  return options.chromeMcp?.capabilities ?? FALLBACK_CHROME_MCP_CAPABILITIES;
}

function buildChromeMcpFeatureArgs(options: NormalizedChromeMcpProfileOptions): string[] {
  const capabilities = resolveChromeMcpCapabilities(options);
  const args = [...DEFAULT_CHROME_MCP_BASE_FEATURE_ARGS];
  if (capabilities.diagnostics) {
    args.push(...DEFAULT_CHROME_MCP_DIAGNOSTIC_FEATURE_ARGS);
  } else if (capabilities.extensions) {
    args.push("--experimentalInteropTools");
  }
  if (capabilities.extensions || capabilities.extensionMutation) {
    args.push(DEFAULT_CHROME_MCP_CATEGORY_FEATURE_ARGS.extensions);
  }
  if (capabilities.thirdPartyTools || capabilities.thirdPartyToolExecution) {
    args.push(DEFAULT_CHROME_MCP_CATEGORY_FEATURE_ARGS.thirdPartyTools);
  }
  if (capabilities.webMcpTools || capabilities.webMcpToolExecution) {
    args.push(DEFAULT_CHROME_MCP_CATEGORY_FEATURE_ARGS.webMcpTools);
  }
  if (options.extraArgs.some((arg) => CHROME_MCP_USAGE_STATISTICS_FLAG_RE.test(arg))) {
    return args.filter((arg) => arg !== "--no-usage-statistics");
  }
  return args;
}

function isChromeMcpPolicyControlledFeatureArg(arg: string): boolean {
  const [name] = arg.split("=", 1);
  return CHROME_MCP_POLICY_CONTROLLED_FEATURE_FLAGS.has(name ?? arg);
}

function buildChromeMcpArgsFromOptions(options: NormalizedChromeMcpProfileOptions): string[] {
  const commandPrefix =
    options.command === DEFAULT_CHROME_MCP_COMMAND ? DEFAULT_CHROME_MCP_PACKAGE_ARGS : [];
  const extraArgs = options.extraArgs.filter((arg) => !isChromeMcpPolicyControlledFeatureArg(arg));
  return [
    ...commandPrefix,
    ...buildChromeMcpConnectionArgs(options),
    ...buildChromeMcpFeatureArgs(options),
    ...buildChromeMcpLaunchArgs(options),
    ...buildChromeMcpUserDataDirArgs(options),
    ...extraArgs,
  ];
}

export function buildChromeMcpArgs(input?: string | ChromeMcpProfileOptions): string[] {
  return buildChromeMcpArgsFromOptions(normalizeChromeMcpOptions(input));
}

function drainStderr(transport: StdioClientTransport): () => string {
  const stream = transport.stderr;
  if (!stream) {
    return () => "";
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  stream.on("data", (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const capped =
      buffer.length > CHROME_MCP_STDERR_MAX_BYTES
        ? buffer.subarray(buffer.length - CHROME_MCP_STDERR_MAX_BYTES)
        : buffer;
    chunks.push(capped);
    totalBytes += capped.length;
    while (totalBytes > CHROME_MCP_STDERR_MAX_BYTES && chunks.length > 1) {
      const dropped = chunks.shift();
      if (dropped) {
        totalBytes -= dropped.length;
      }
    }
  });
  stream.on("error", () => {});
  return () => Buffer.concat(chunks).toString("utf8").trim().slice(-CHROME_MCP_STDERR_MAX_BYTES);
}

function redactChromeMcpDiagnosticText(text: string): string {
  return redactToolPayloadText(
    text.replace(CDP_URL_IN_TEXT_RE, (match) =>
      redactToolPayloadText(redactCdpUrl(match) ?? match),
    ),
  );
}

function redactChromeMcpDiagnosticTextWithLocalPaths(text: string): string {
  const homeDir = normalizeOptionalString(os.homedir());
  const homePath = homeDir ? path.resolve(homeDir) : undefined;
  const withHomeRedacted = homePath ? text.split(homePath).join("~") : text;
  return redactChromeMcpDiagnosticText(withHomeRedacted);
}

function redactChromeMcpLocalPathForDiagnostic(filePath: string): string {
  const homeDir = normalizeOptionalString(os.homedir());
  if (!homeDir || !path.isAbsolute(filePath)) {
    return redactChromeMcpDiagnosticText(filePath);
  }

  const relative = path.relative(path.resolve(homeDir), path.resolve(filePath));
  if (relative === "") {
    return "~";
  }
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return redactChromeMcpDiagnosticText(`~/${relative.split(path.sep).join("/")}`);
  }
  return redactChromeMcpDiagnosticText(filePath);
}

function redactChromeMcpProfileLabelForDiagnostic(profileName: string): string {
  return path.isAbsolute(profileName)
    ? redactChromeMcpLocalPathForDiagnostic(profileName)
    : redactChromeMcpDiagnosticText(profileName);
}

function readChromeMcpTransportPid(transport: StdioClientTransport): number | undefined {
  const pid = transport.pid;
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 && pid !== process.pid
    ? pid
    : undefined;
}

function parseChromeMcpProcessList(stdout: string): ChromeMcpProcessInfo[] {
  const processes: ChromeMcpProcessInfo[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(?<pid>\d+)\s+(?<ppid>\d+)\s*$/.exec(line);
    if (!match?.groups) {
      continue;
    }
    processes.push({
      pid: Number.parseInt(match.groups.pid, 10),
      ppid: Number.parseInt(match.groups.ppid, 10),
    });
  }
  return processes;
}

async function listChromeMcpPlatformProcesses(
  deps: ChromeMcpProcessCleanupDeps | null,
): Promise<ChromeMcpProcessInfo[]> {
  if (deps?.listProcesses) {
    return await deps.listProcesses();
  }
  if ((deps?.platform ?? process.platform) === "win32") {
    return [];
  }
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid="], {
    maxBuffer: 4 * 1024 * 1024,
  });
  return parseChromeMcpProcessList(stdout);
}

function collectChromeMcpProcessTreePids(
  rootPid: number,
  processes: ChromeMcpProcessInfo[],
): number[] {
  const childrenByParent = new Map<number, ChromeMcpProcessInfo[]>();
  for (const processInfo of processes) {
    const children = childrenByParent.get(processInfo.ppid) ?? [];
    children.push(processInfo);
    childrenByParent.set(processInfo.ppid, children);
  }

  const collected: number[] = [];
  const queue = [...(childrenByParent.get(rootPid) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || next.pid === process.pid || next.pid === rootPid || collected.includes(next.pid)) {
      continue;
    }
    collected.push(next.pid);
    queue.push(...(childrenByParent.get(next.pid) ?? []));
  }
  return collected;
}

async function collectChromeMcpDescendantPids(
  rootPid: number,
  deps: ChromeMcpProcessCleanupDeps | null,
): Promise<number[]> {
  try {
    return collectChromeMcpProcessTreePids(rootPid, await listChromeMcpPlatformProcesses(deps));
  } catch (err) {
    log.trace(
      `Unable to inspect Chrome MCP subprocess tree for pid ${rootPid}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

function isChromeMcpProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function taskkillChromeMcpProcessTree(
  rootPid: number,
  deps: ChromeMcpProcessCleanupDeps | null,
): Promise<void> {
  if (deps?.taskkillProcessTree) {
    await deps.taskkillProcessTree(rootPid);
    return;
  }
  await execFileAsync("taskkill", ["/pid", String(rootPid), "/t", "/f"], {
    windowsHide: true,
  });
}

async function terminateChromeMcpProcessTree(
  rootPid: number | undefined,
  descendantPids: number[],
): Promise<void> {
  if (!rootPid) {
    return;
  }

  const deps = chromeMcpProcessCleanupDepsForTest;
  if ((deps?.platform ?? process.platform) === "win32") {
    await taskkillChromeMcpProcessTree(rootPid, deps);
    return;
  }

  const killProcess = deps?.killProcess ?? ((pid, signal) => process.kill(pid, signal));
  const sleep = deps?.sleep ?? sleepTimeout;
  const pids = uniqueValues([...descendantPids.toReversed(), rootPid]).filter(
    (pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid,
  );
  const signaled: number[] = [];

  for (const pid of pids) {
    try {
      killProcess(pid, "SIGTERM");
      signaled.push(pid);
    } catch {
      // The process may already have exited as part of client.close().
    }
  }
  if (signaled.length === 0) {
    return;
  }

  await sleep(CHROME_MCP_PROCESS_EXIT_GRACE_MS);
  for (const pid of signaled) {
    if (deps?.killProcess || isChromeMcpProcessAlive(pid)) {
      try {
        killProcess(pid, "SIGKILL");
      } catch {
        // Best-effort cleanup only.
      }
    }
  }
}

async function closeChromeMcpClientAndProcess(params: {
  client: Client;
  transport: StdioClientTransport;
  ownsProcessTree?: boolean;
}): Promise<void> {
  const deps = chromeMcpProcessCleanupDepsForTest;
  const rootPid = params.ownsProcessTree ? readChromeMcpTransportPid(params.transport) : undefined;
  const descendantPids = rootPid ? await collectChromeMcpDescendantPids(rootPid, deps) : [];
  const terminateBeforeClientClose = Boolean(
    rootPid && (deps?.platform ?? process.platform) === "win32",
  );
  if (terminateBeforeClientClose) {
    try {
      await terminateChromeMcpProcessTree(rootPid, descendantPids);
    } catch (err) {
      log.trace(
        `Unable to pre-terminate Chrome MCP subprocess tree for pid ${rootPid}: ${err instanceof Error ? err.message : String(err)}`,
      );
      await params.client.close().catch(() => {});
    }
    return;
  }
  await params.client.close().catch(() => {});
  await terminateChromeMcpProcessTree(rootPid, descendantPids).catch((err) => {
    log.trace(
      `Unable to fully terminate Chrome MCP subprocess tree for pid ${rootPid}: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

async function closeChromeMcpSessionHandle(session: ChromeMcpSession): Promise<void> {
  await closeChromeMcpClientAndProcess({
    client: session.client,
    transport: session.transport,
    ownsProcessTree: session.ownsProcessTree,
  });
  if (session.options) {
    await terminateChromeMcpBrowserProcessesForOptions(session.options);
  }
}

async function withChromeMcpHandshakeTimeout<T>(task: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Chrome MCP handshake timed out")),
          CHROME_MCP_HANDSHAKE_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function createRealSession(
  profileName: string,
  options: NormalizedChromeMcpProfileOptions = normalizeChromeMcpOptions(),
): Promise<ChromeMcpSession> {
  const transport = new StdioClientTransport({
    command: options.command,
    args: buildChromeMcpArgsFromOptions(options),
    stderr: "pipe",
  });
  const client = new Client(
    {
      name: "openclaw-browser",
      version: "0.0.0",
    },
    {},
  );

  let getStderr = () => "";
  const ready = (async () => {
    try {
      await withChromeMcpHandshakeTimeout(
        (async () => {
          await client.connect(transport);
          getStderr = drainStderr(transport);
          const tools = await client.listTools();
          if (!tools.tools.some((tool) => tool.name === "list_pages")) {
            throw new Error("Chrome MCP server did not expose the expected navigation tools.");
          }
        })(),
      );
    } catch (err) {
      await closeChromeMcpClientAndProcess({ client, transport, ownsProcessTree: true });
      await terminateChromeMcpBrowserProcessesForOptions(options);
      const stderr = getStderr();
      if (stderr) {
        log.warn(
          `Chrome MCP attach failed for profile "${redactChromeMcpProfileLabelForDiagnostic(profileName)}". Subprocess stderr:\n${redactChromeMcpDiagnosticTextWithLocalPaths(stderr)}`,
        );
      }
      const targetLabel = options.browserUrl
        ? `the configured Chrome endpoint (${redactToolPayloadText(redactCdpUrl(options.browserUrl) ?? options.browserUrl)})`
        : options.userDataDir
          ? `the configured Chromium user data dir (${redactChromeMcpLocalPathForDiagnostic(options.userDataDir)})`
          : "Google Chrome's default profile";
      const detail = redactChromeMcpDiagnosticTextWithLocalPaths(
        err instanceof Error ? err.message : String(err),
      );
      throw new BrowserProfileUnavailableError(
        `Chrome MCP existing-session attach failed for profile "${redactChromeMcpProfileLabelForDiagnostic(profileName)}". ` +
          `Make sure ${targetLabel} is running locally with remote debugging enabled. ` +
          `Details: ${detail}`,
      );
    }
  })();
  ready.catch(() => {});

  return {
    client,
    transport,
    ready,
    ownsProcessTree: true,
    options,
  };
}

async function waitForChromeMcpReady(
  session: ChromeMcpSession,
  profileName: string,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("aborted");
  }
  if ((!timeoutMs || timeoutMs <= 0) && !signal) {
    await session.ready;
    return;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  try {
    const racers: Array<Promise<void> | Promise<never>> = [session.ready];
    if (timeoutMs && timeoutMs > 0) {
      racers.push(
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new BrowserProfileUnavailableError(
                `Chrome MCP existing-session attach for profile "${redactChromeMcpProfileLabelForDiagnostic(profileName)}" timed out after ${timeoutMs}ms.`,
              ),
            );
          }, timeoutMs);
        }),
      );
    }
    if (signal) {
      racers.push(
        new Promise<never>((_, reject) => {
          abortListener = () => reject(signal.reason ?? new Error("aborted"));
          signal.addEventListener("abort", abortListener, { once: true });
        }),
      );
    }
    await Promise.race(racers);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (signal && abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

async function waitForChromeMcpPendingSession(
  pending: Promise<ChromeMcpSession>,
  signal?: AbortSignal,
): Promise<ChromeMcpSession> {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("aborted");
  }
  if (!signal) {
    return await pending;
  }

  let abortListener: (() => void) | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        abortListener = () => reject(signal.reason ?? new Error("aborted"));
        signal.addEventListener("abort", abortListener, { once: true });
      }),
    ]);
  } finally {
    if (abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

async function createChromeMcpSession(
  profileName: string,
  options: NormalizedChromeMcpProfileOptions,
  signal?: AbortSignal,
): Promise<ChromeMcpSession> {
  const created = (sessionFactory ?? createRealSession)(profileName, options);
  try {
    const session = await waitForChromeMcpPendingSession(created, signal);
    session.options = options;
    if (signal?.aborted) {
      await closeChromeMcpSessionHandle(session);
      throw signal.reason ?? new Error("aborted");
    }
    return session;
  } catch (err) {
    if (signal?.aborted) {
      void created.then((session) => closeChromeMcpSessionHandle(session)).catch(() => {});
    }
    throw err;
  }
}

async function getSession(
  profileName: string,
  profileOptions?: ChromeMcpOptionsInput,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<ChromeMcpSession> {
  const options = normalizeChromeMcpOptions(profileOptions);
  const cacheKey = buildChromeMcpSessionCacheKey(profileName, options);
  await closeChromeMcpSessionsForProfile(profileName, cacheKey);

  let session = sessions.get(cacheKey);
  if (session && session.transport.pid === null) {
    sessions.delete(cacheKey);
    session = undefined;
  }
  if (!session) {
    let pending = pendingSessions.get(cacheKey);
    if (!pending) {
      pending = (async () => {
        const created = await createChromeMcpSession(profileName, options, signal);
        if (pendingSessions.get(cacheKey) === pending) {
          sessions.set(cacheKey, created);
        } else {
          await closeChromeMcpSessionHandle(created);
        }
        return created;
      })();
      pendingSessions.set(cacheKey, pending);
    }
    try {
      session = await pending;
    } finally {
      if (pendingSessions.get(cacheKey) === pending) {
        pendingSessions.delete(cacheKey);
      }
    }
  }
  try {
    await waitForChromeMcpReady(session, profileName, timeoutMs, signal);
    return session;
  } catch (err) {
    const current = sessions.get(cacheKey);
    if (current?.transport === session.transport) {
      sessions.delete(cacheKey);
    }
    throw err;
  }
}

async function getExistingSession(
  cacheKey: string,
  profileName: string,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<ChromeMcpSession | null> {
  let session = sessions.get(cacheKey);
  if (session && session.transport.pid === null) {
    sessions.delete(cacheKey);
    session = undefined;
  }
  if (session) {
    try {
      await waitForChromeMcpReady(session, profileName, timeoutMs, signal);
      return session;
    } catch (err) {
      const current = sessions.get(cacheKey);
      if (current?.transport === session.transport) {
        sessions.delete(cacheKey);
      }
      throw err;
    }
  }

  const pending = pendingSessions.get(cacheKey);
  if (!pending) {
    return null;
  }

  session = await waitForChromeMcpPendingSession(pending, signal);
  try {
    await waitForChromeMcpReady(session, profileName, timeoutMs, signal);
    return session;
  } catch (err) {
    const current = sessions.get(cacheKey);
    if (current?.transport === session.transport) {
      sessions.delete(cacheKey);
    }
    throw err;
  }
}

async function createEphemeralSession(
  profileName: string,
  profileOptions?: ChromeMcpOptionsInput,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<ChromeMcpSession> {
  const options = normalizeChromeMcpOptions(profileOptions);
  const session = await createChromeMcpSession(profileName, options, signal);
  try {
    await waitForChromeMcpReady(session, profileName, timeoutMs, signal);
    return session;
  } catch (err) {
    await closeChromeMcpSessionHandle(session);
    throw err;
  }
}

async function leaseSession(
  profileName: string,
  profileOptions?: ChromeMcpOptionsInput,
  options: ChromeMcpCallOptions = {},
): Promise<ChromeMcpSessionLease> {
  const normalizedProfileOptions = normalizeChromeMcpOptions(profileOptions);
  const cacheKey = buildChromeMcpSessionCacheKey(profileName, normalizedProfileOptions);
  if (!options.ephemeral) {
    return {
      session: await getSession(
        profileName,
        normalizedProfileOptions,
        options.timeoutMs,
        options.signal,
      ),
      cacheKey,
      temporary: false,
    };
  }

  // Status probes should avoid seeding the shared attach session cache, but they can safely
  // reuse a real cached session if one already exists.
  const existingSession = await getExistingSession(
    cacheKey,
    profileName,
    options.timeoutMs,
    options.signal,
  );
  if (existingSession) {
    return {
      session: existingSession,
      cacheKey,
      temporary: false,
    };
  }

  return {
    session: await createEphemeralSession(
      profileName,
      normalizedProfileOptions,
      options.timeoutMs,
      options.signal,
    ),
    cacheKey,
    temporary: true,
  };
}

async function callTool(
  profileName: string,
  profileOptions: ChromeMcpOptionsInput | undefined,
  name: string,
  args: Record<string, unknown> = {},
  options: ChromeMcpCallOptions = {},
): Promise<ChromeMcpToolResult> {
  const timeoutMs = options.timeoutMs;
  const signal = options.signal;
  if (signal?.aborted) {
    throw signal.reason ?? new Error("aborted");
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const lease = await leaseSession(profileName, profileOptions, options);
    const rawCall = lease.session.client.callTool({
      name,
      arguments: args,
    }) as Promise<ChromeMcpToolResult>;

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const racers: Array<Promise<ChromeMcpToolResult> | Promise<never>> = [rawCall];

    if (timeoutMs !== undefined && timeoutMs > 0) {
      racers.push(
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(
              new Error(
                `Chrome MCP "${name}" timed out after ${timeoutMs}ms. Session reset for reconnect.`,
              ),
            );
          }, timeoutMs);
        }),
      );
    }

    if (signal) {
      racers.push(
        new Promise<never>((_, reject) => {
          abortListener = () => reject(signal.reason ?? new Error("aborted"));
          signal.addEventListener("abort", abortListener, { once: true });
        }),
      );
    }

    let result: ChromeMcpToolResult;
    try {
      result = racers.length === 1 ? await rawCall : await Promise.race(racers);
    } catch (err) {
      void rawCall.catch(() => {});
      // Transport/connection error, timeout, or abort: tear down session so it reconnects.
      // Transport-identity check prevents clobbering a replacement session created concurrently.
      if (!lease.temporary) {
        const cur = sessions.get(lease.cacheKey);
        if (cur?.transport === lease.session.transport) {
          sessions.delete(lease.cacheKey);
          await closeChromeMcpSessionHandle(lease.session);
        }
      }
      throw err;
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
      if (lease.temporary) {
        await closeChromeMcpSessionHandle(lease.session);
      }
    }
    // Tool-level errors (element not found, script error, etc.) don't indicate a
    // broken connection. A stale selected-page error does poison the Chrome MCP
    // session, so reconnect and retry that one once.
    if (result.isError) {
      const message = extractToolErrorMessage(result, name);
      if (shouldReconnectForToolError(name, message)) {
        if (!lease.temporary) {
          const cur = sessions.get(lease.cacheKey);
          if (cur?.transport === lease.session.transport) {
            sessions.delete(lease.cacheKey);
            await closeChromeMcpSessionHandle(lease.session);
          }
        }
        if (attempt === 0) {
          continue;
        }
      }
      throw new Error(message);
    }
    return result;
  }
  throw new Error(`Chrome MCP tool "${name}" failed after reconnect.`);
}

async function withTempFile<T>(fn: (filePath: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-chrome-mcp-"));
  const filePath = path.join(dir, randomUUID());
  try {
    return await fn(filePath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function findPageById(
  profileName: string,
  pageId: number,
  profileOptions?: string | ChromeMcpProfileOptions,
): Promise<ChromeMcpStructuredPage> {
  const pages = await listChromeMcpPages(profileName, profileOptions);
  const page = pages.find((entry) => entry.id === pageId);
  if (!page) {
    throw new BrowserTabNotFoundError();
  }
  return page;
}

export async function ensureChromeMcpAvailable(
  profileName: string,
  profileOptions?: string | ChromeMcpProfileOptions,
  options: ChromeMcpCallOptions = {},
): Promise<void> {
  const lease = await leaseSession(profileName, profileOptions, options);
  if (lease.temporary) {
    await closeChromeMcpSessionHandle(lease.session);
  }
}

export function getChromeMcpPid(profileName: string): number | null {
  for (const [key, session] of sessions.entries()) {
    if (cacheKeyMatchesProfileName(key, profileName)) {
      return session.transport.pid ?? null;
    }
  }
  return null;
}

export async function closeChromeMcpSession(
  profileName: string,
  profileOptions?: string | ChromeMcpProfileOptions,
): Promise<boolean> {
  return await closeChromeMcpSessionsForProfile(profileName, undefined, profileOptions);
}

export async function stopAllChromeMcpSessions(): Promise<void> {
  const names = uniqueStrings([...sessions.keys()].map((key) => JSON.parse(key)[0] as string));
  for (const name of names) {
    await closeChromeMcpSession(name).catch(() => {});
  }
}

export async function listChromeMcpPages(
  profileName: string,
  profileOptions?: string | ChromeMcpProfileOptions,
  options: ChromeMcpCallOptions = {},
): Promise<ChromeMcpStructuredPage[]> {
  const result = await callTool(profileName, profileOptions, "list_pages", {}, options);
  return extractStructuredPages(result);
}

export async function listChromeMcpTabs(
  profileName: string,
  profileOptions?: string | ChromeMcpProfileOptions,
  options: ChromeMcpCallOptions = {},
): Promise<BrowserTab[]> {
  return toBrowserTabs(await listChromeMcpPages(profileName, profileOptions, options));
}

export async function openChromeMcpTab(
  profileName: string,
  url: string,
  profileOptions?: string | ChromeMcpProfileOptions,
): Promise<BrowserTab> {
  const targetUrl = url.trim() || "about:blank";
  const result = await callTool(profileName, profileOptions, "new_page", {
    url: "about:blank",
    timeout: CHROME_MCP_NEW_PAGE_TIMEOUT_MS,
  });
  const pages = extractStructuredPages(result);
  const chosen = pages.find((page) => page.selected) ?? pages.at(-1);
  if (!chosen) {
    throw new Error("Chrome MCP did not return the created page.");
  }
  const targetId = String(chosen.id);
  const finalUrl =
    targetUrl === "about:blank"
      ? (chosen.url ?? targetUrl)
      : (
          await navigateChromeMcpPage({
            profileName,
            profile: typeof profileOptions === "string" ? undefined : profileOptions,
            userDataDir: typeof profileOptions === "string" ? profileOptions : undefined,
            targetId,
            url: targetUrl,
            timeoutMs: CHROME_MCP_NAVIGATE_TIMEOUT_MS,
          })
        ).url;
  return {
    targetId,
    title: "",
    url: finalUrl,
    type: "page",
  };
}

export async function focusChromeMcpTab(
  profileName: string,
  targetId: string,
  profileOptions?: string | ChromeMcpProfileOptions,
): Promise<void> {
  await callTool(profileName, profileOptions, "select_page", {
    pageId: parsePageId(targetId),
    bringToFront: true,
  });
}

export async function closeChromeMcpTab(
  profileName: string,
  targetId: string,
  profileOptions?: string | ChromeMcpProfileOptions,
): Promise<void> {
  await callTool(profileName, profileOptions, "close_page", { pageId: parsePageId(targetId) });
}

export async function navigateChromeMcpPage(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  url: string;
  timeoutMs?: number;
}): Promise<{ url: string }> {
  const resolvedTimeoutMs = params.timeoutMs ?? CHROME_MCP_NAVIGATE_TIMEOUT_MS;
  await callTool(
    params.profileName,
    chromeMcpProfileOptionsFromParams(params),
    "navigate_page",
    {
      pageId: parsePageId(params.targetId),
      type: "url",
      url: params.url,
      timeout: resolvedTimeoutMs,
    },
    { timeoutMs: resolvedTimeoutMs + 5_000 },
  );
  const page = await findPageById(
    params.profileName,
    parsePageId(params.targetId),
    chromeMcpProfileOptionsFromParams(params),
  );
  return { url: page.url ?? params.url };
}

export async function takeChromeMcpSnapshot(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  timeoutMs?: number;
}): Promise<ChromeMcpSnapshotNode> {
  const result = await callTool(
    params.profileName,
    chromeMcpProfileOptionsFromParams(params),
    "take_snapshot",
    {
      pageId: parsePageId(params.targetId),
    },
    { timeoutMs: params.timeoutMs },
  );
  return extractSnapshot(result);
}

export async function takeChromeMcpScreenshot(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  uid?: string;
  fullPage?: boolean;
  format?: "png" | "jpeg";
  timeoutMs?: number;
}): Promise<Buffer> {
  return await withTempFile(async (filePath) => {
    const format = params.format ?? "png";
    await callTool(
      params.profileName,
      chromeMcpProfileOptionsFromParams(params),
      "take_screenshot",
      {
        pageId: parsePageId(params.targetId),
        filePath,
        format,
        ...(params.uid ? { uid: params.uid } : {}),
        ...(params.fullPage ? { fullPage: true } : {}),
      },
      { timeoutMs: params.timeoutMs },
    );
    return await fs.readFile(`${filePath}.${format}`);
  });
}

export async function clickChromeMcpElement(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  uid: string;
  doubleClick?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<void> {
  await callTool(
    params.profileName,
    chromeMcpProfileOptionsFromParams(params),
    "click",
    {
      pageId: parsePageId(params.targetId),
      uid: params.uid,
      ...(params.doubleClick ? { dblClick: true } : {}),
    },
    {
      timeoutMs: params.timeoutMs,
      signal: params.signal,
    },
  );
}

export async function clickChromeMcpCoords(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  x: number;
  y: number;
  doubleClick?: boolean;
  button?: "left" | "right" | "middle";
  delayMs?: number;
}): Promise<void> {
  const button = params.button ?? "left";
  const delayMsValue = Math.max(0, Math.floor(params.delayMs ?? 0));
  if (button === "left" && delayMsValue === 0) {
    await callTool(params.profileName, chromeMcpProfileOptionsFromParams(params), "click_at", {
      pageId: parsePageId(params.targetId),
      x: params.x,
      y: params.y,
      ...(params.doubleClick ? { dblClick: true } : {}),
    });
    return;
  }

  const buttonCode = button === "middle" ? 1 : button === "right" ? 2 : 0;
  const pressedButtons = button === "middle" ? 4 : button === "right" ? 2 : 1;
  const x = JSON.stringify(params.x);
  const y = JSON.stringify(params.y);
  const delayMs = JSON.stringify(delayMsValue);
  const doubleClick = params.doubleClick ? "true" : "false";
  await evaluateChromeMcpScript({
    profileName: params.profileName,
    profile: params.profile,
    userDataDir: params.userDataDir,
    targetId: params.targetId,
    fn: `async () => {
      const x = ${x};
      const y = ${y};
      const delayMs = ${delayMs};
      const doubleClick = ${doubleClick};
      const target = document.elementFromPoint(x, y) ?? document.body ?? document.documentElement ?? document;
      const base = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        screenX: window.screenX + x,
        screenY: window.screenY + y,
        button: ${buttonCode},
      };
      const pressedButtons = ${pressedButtons};
      const dispatch = (type, buttons, detail) => {
        target.dispatchEvent(new MouseEvent(type, { ...base, buttons, detail }));
      };
      dispatch("mousemove", 0, 0);
      dispatch("mousedown", pressedButtons, 1);
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      dispatch("mouseup", 0, 1);
      dispatch("click", 0, 1);
      if (doubleClick) {
        dispatch("mousedown", pressedButtons, 2);
        dispatch("mouseup", 0, 2);
        dispatch("click", 0, 2);
        dispatch("dblclick", 0, 2);
      }
      return true;
    }`,
  });
}

export async function fillChromeMcpElement(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  uid: string;
  value: string;
}): Promise<void> {
  await callTool(params.profileName, chromeMcpProfileOptionsFromParams(params), "fill", {
    pageId: parsePageId(params.targetId),
    uid: params.uid,
    value: params.value,
  });
}

export async function fillChromeMcpForm(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  elements: Array<{ uid: string; value: string }>;
}): Promise<void> {
  await callTool(params.profileName, chromeMcpProfileOptionsFromParams(params), "fill_form", {
    pageId: parsePageId(params.targetId),
    elements: params.elements,
  });
}

export async function hoverChromeMcpElement(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  uid: string;
}): Promise<void> {
  await callTool(params.profileName, chromeMcpProfileOptionsFromParams(params), "hover", {
    pageId: parsePageId(params.targetId),
    uid: params.uid,
  });
}

export async function dragChromeMcpElement(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  fromUid: string;
  toUid: string;
}): Promise<void> {
  await callTool(params.profileName, chromeMcpProfileOptionsFromParams(params), "drag", {
    pageId: parsePageId(params.targetId),
    from_uid: params.fromUid,
    to_uid: params.toUid,
  });
}

export async function uploadChromeMcpFile(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  uid: string;
  filePath: string;
}): Promise<void> {
  await callTool(params.profileName, chromeMcpProfileOptionsFromParams(params), "upload_file", {
    pageId: parsePageId(params.targetId),
    uid: params.uid,
    filePath: params.filePath,
  });
}

export async function pressChromeMcpKey(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  key: string;
}): Promise<void> {
  await callTool(params.profileName, chromeMcpProfileOptionsFromParams(params), "press_key", {
    pageId: parsePageId(params.targetId),
    key: params.key,
  });
}

export async function resizeChromeMcpPage(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  width: number;
  height: number;
}): Promise<void> {
  await callTool(params.profileName, chromeMcpProfileOptionsFromParams(params), "resize_page", {
    pageId: parsePageId(params.targetId),
    width: params.width,
    height: params.height,
  });
}

export async function emulateChromeMcpPage(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  offline?: boolean;
  geolocation?: { latitude: number; longitude: number } | null;
  colorScheme?: "dark" | "light" | "auto";
}): Promise<void> {
  const profileOptions = chromeMcpProfileOptionsFromParams(params);
  const stateKey = buildChromeMcpPageStateKey(
    params.profileName,
    normalizeChromeMcpOptions(profileOptions),
    params.targetId,
  );
  const nextState: ChromeMcpTrackedEmulationState = { ...emulationStates.get(stateKey) };

  if (params.offline !== undefined) {
    if (params.offline) {
      nextState.networkConditions = "Offline";
    } else {
      delete nextState.networkConditions;
    }
  }
  if (Object.hasOwn(params, "geolocation")) {
    if (params.geolocation) {
      nextState.geolocation = `${params.geolocation.latitude},${params.geolocation.longitude}`;
    } else {
      delete nextState.geolocation;
    }
  }
  if (params.colorScheme !== undefined) {
    if (params.colorScheme === "auto") {
      delete nextState.colorScheme;
    } else {
      nextState.colorScheme = params.colorScheme;
    }
  }

  await callTool(params.profileName, profileOptions, "emulate", {
    pageId: parsePageId(params.targetId),
    ...(nextState.networkConditions ? { networkConditions: nextState.networkConditions } : {}),
    ...(nextState.geolocation ? { geolocation: nextState.geolocation } : {}),
    ...(nextState.colorScheme ? { colorScheme: nextState.colorScheme } : {}),
  });

  if (Object.keys(nextState).length > 0) {
    emulationStates.set(stateKey, nextState);
  } else {
    emulationStates.delete(stateKey);
  }
}

export async function startChromeMcpPerformanceTrace(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  reload?: boolean;
  autoStop?: boolean;
  filePath?: string;
  timeoutMs?: number;
}): Promise<string> {
  const result = await callTool(
    params.profileName,
    chromeMcpProfileOptionsFromParams(params),
    "performance_start_trace",
    {
      pageId: parsePageId(params.targetId),
      reload: params.reload ?? false,
      autoStop: params.autoStop ?? false,
      ...(params.filePath ? { filePath: params.filePath } : {}),
    },
    { timeoutMs: params.timeoutMs },
  );
  return extractMessageText(result);
}

export async function stopChromeMcpPerformanceTrace(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  filePath?: string;
  timeoutMs?: number;
}): Promise<string> {
  const result = await callTool(
    params.profileName,
    chromeMcpProfileOptionsFromParams(params),
    "performance_stop_trace",
    {
      pageId: parsePageId(params.targetId),
      ...(params.filePath ? { filePath: params.filePath } : {}),
    },
    { timeoutMs: params.timeoutMs },
  );
  return extractMessageText(result);
}

export async function analyzeChromeMcpPerformanceInsight(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  insightSetId: string;
  insightName: string;
  timeoutMs?: number;
}): Promise<string> {
  const result = await callTool(
    params.profileName,
    chromeMcpProfileOptionsFromParams(params),
    "performance_analyze_insight",
    {
      pageId: parsePageId(params.targetId),
      insightSetId: params.insightSetId,
      insightName: params.insightName,
    },
    { timeoutMs: params.timeoutMs },
  );
  return extractMessageText(result);
}

export type ChromeMcpHeapSnapshotInspectionResult = {
  output: string;
  structuredContent?: Record<string, unknown>;
};

function toHeapSnapshotInspectionResult(
  result: ChromeMcpToolResult,
): ChromeMcpHeapSnapshotInspectionResult {
  const structuredContent = extractStructuredContent(result);
  return {
    output: extractMessageText(result),
    ...(Object.keys(structuredContent).length > 0 ? { structuredContent } : {}),
  };
}

export async function takeChromeMcpHeapSnapshot(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  filePath: string;
  timeoutMs?: number;
}): Promise<string> {
  const result = await callTool(
    params.profileName,
    chromeMcpProfileOptionsFromParams(params),
    "take_memory_snapshot",
    {
      pageId: parsePageId(params.targetId),
      filePath: params.filePath,
    },
    { timeoutMs: params.timeoutMs },
  );
  return extractMessageText(result);
}

export async function getChromeMcpHeapSnapshotSummary(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  filePath: string;
  timeoutMs?: number;
}): Promise<ChromeMcpHeapSnapshotInspectionResult> {
  const result = await callTool(
    params.profileName,
    chromeMcpProfileOptionsFromParams(params),
    "load_memory_snapshot",
    { filePath: params.filePath },
    { timeoutMs: params.timeoutMs },
  );
  return toHeapSnapshotInspectionResult(result);
}

export async function getChromeMcpHeapSnapshotDetails(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  filePath: string;
  pageIdx?: number;
  pageSize?: number;
  timeoutMs?: number;
}): Promise<ChromeMcpHeapSnapshotInspectionResult> {
  const result = await callTool(
    params.profileName,
    chromeMcpProfileOptionsFromParams(params),
    "get_memory_snapshot_details",
    {
      filePath: params.filePath,
      ...(params.pageIdx !== undefined ? { pageIdx: params.pageIdx } : {}),
      ...(params.pageSize !== undefined ? { pageSize: params.pageSize } : {}),
    },
    { timeoutMs: params.timeoutMs },
  );
  return toHeapSnapshotInspectionResult(result);
}

export async function getChromeMcpHeapSnapshotClassNodes(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  filePath: string;
  id: number;
  pageIdx?: number;
  pageSize?: number;
  timeoutMs?: number;
}): Promise<ChromeMcpHeapSnapshotInspectionResult> {
  const result = await callTool(
    params.profileName,
    chromeMcpProfileOptionsFromParams(params),
    "get_nodes_by_class",
    {
      filePath: params.filePath,
      uid: params.id,
      ...(params.pageIdx !== undefined ? { pageIdx: params.pageIdx } : {}),
      ...(params.pageSize !== undefined ? { pageSize: params.pageSize } : {}),
    },
    { timeoutMs: params.timeoutMs },
  );
  return toHeapSnapshotInspectionResult(result);
}

export async function getChromeMcpHeapSnapshotRetainers(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  filePath: string;
  nodeId: number;
  pageIdx?: number;
  pageSize?: number;
  timeoutMs?: number;
}): Promise<ChromeMcpHeapSnapshotInspectionResult> {
  const result = await callTool(
    params.profileName,
    chromeMcpProfileOptionsFromParams(params),
    "get_node_retainers",
    {
      filePath: params.filePath,
      nodeId: params.nodeId,
      ...(params.pageIdx !== undefined ? { pageIdx: params.pageIdx } : {}),
      ...(params.pageSize !== undefined ? { pageSize: params.pageSize } : {}),
    },
    { timeoutMs: params.timeoutMs },
  );
  return toHeapSnapshotInspectionResult(result);
}

export type ChromeMcpLighthouseAuditResult = {
  output: string;
  structuredContent?: Record<string, unknown>;
};

export async function runChromeMcpLighthouseAudit(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  mode?: "navigation" | "snapshot";
  device?: "desktop" | "mobile";
  outputDirPath?: string;
  timeoutMs?: number;
}): Promise<ChromeMcpLighthouseAuditResult> {
  const result = await callTool(
    params.profileName,
    chromeMcpProfileOptionsFromParams(params),
    "lighthouse_audit",
    {
      pageId: parsePageId(params.targetId),
      ...(params.mode ? { mode: params.mode } : {}),
      ...(params.device ? { device: params.device } : {}),
      ...(params.outputDirPath ? { outputDirPath: params.outputDirPath } : {}),
    },
    { timeoutMs: params.timeoutMs },
  );
  const structuredContent = extractStructuredContent(result);
  return {
    output: extractMessageText(result),
    ...(Object.keys(structuredContent).length > 0 ? { structuredContent } : {}),
  };
}

export async function startChromeMcpScreencast(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  filePath?: string;
  timeoutMs?: number;
}): Promise<string> {
  const result = await callTool(
    params.profileName,
    chromeMcpProfileOptionsFromParams(params),
    "screencast_start",
    {
      pageId: parsePageId(params.targetId),
      ...(params.filePath ? { filePath: params.filePath } : {}),
    },
    { timeoutMs: params.timeoutMs },
  );
  return extractMessageText(result);
}

export async function stopChromeMcpScreencast(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  timeoutMs?: number;
}): Promise<string> {
  const result = await callTool(
    params.profileName,
    chromeMcpProfileOptionsFromParams(params),
    "screencast_stop",
    { pageId: parsePageId(params.targetId) },
    { timeoutMs: params.timeoutMs },
  );
  return extractMessageText(result);
}

export async function listChromeMcpExtensions(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  timeoutMs?: number;
}): Promise<ChromeMcpExtension[]> {
  const result = await callTool(
    params.profileName,
    chromeMcpProfileOptionsFromParams(params),
    "list_extensions",
    {},
    { timeoutMs: params.timeoutMs },
  );
  return extractExtensions(result);
}

export async function installChromeMcpExtension(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  path: string;
  timeoutMs?: number;
}): Promise<string> {
  const result = await callTool(
    params.profileName,
    chromeMcpProfileOptionsFromParams(params),
    "install_extension",
    { path: params.path },
    { timeoutMs: params.timeoutMs },
  );
  return extractMessageText(result);
}

export async function uninstallChromeMcpExtension(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  id: string;
  timeoutMs?: number;
}): Promise<string> {
  const result = await callTool(
    params.profileName,
    chromeMcpProfileOptionsFromParams(params),
    "uninstall_extension",
    { id: params.id },
    { timeoutMs: params.timeoutMs },
  );
  return extractMessageText(result);
}

export async function reloadChromeMcpExtension(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  id: string;
  timeoutMs?: number;
}): Promise<string> {
  const result = await callTool(
    params.profileName,
    chromeMcpProfileOptionsFromParams(params),
    "reload_extension",
    { id: params.id },
    { timeoutMs: params.timeoutMs },
  );
  return extractMessageText(result);
}

export async function triggerChromeMcpExtensionAction(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  id: string;
  timeoutMs?: number;
}): Promise<string> {
  const result = await callTool(
    params.profileName,
    chromeMcpProfileOptionsFromParams(params),
    "trigger_extension_action",
    { id: params.id },
    { timeoutMs: params.timeoutMs },
  );
  return extractMessageText(result);
}

export async function getChromeMcpTabId(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  timeoutMs?: number;
}): Promise<string | undefined> {
  const result = await callTool(
    params.profileName,
    chromeMcpProfileOptionsFromParams(params),
    "get_tab_id",
    { pageId: parsePageId(params.targetId) },
    { timeoutMs: params.timeoutMs },
  );
  return (
    readStringValue(extractStructuredContent(result).tabId) ??
    normalizeOptionalString(extractMessageText(result))
  );
}

export async function listChromeMcpThirdPartyDeveloperTools(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  timeoutMs?: number;
}): Promise<ChromeMcpGenericToolResult> {
  const result = await callTool(
    params.profileName,
    chromeMcpProfileOptionsFromParams(params),
    "list_3p_developer_tools",
    { pageId: parsePageId(params.targetId) },
    { timeoutMs: params.timeoutMs },
  );
  return toGenericToolResult(result);
}

export async function executeChromeMcpThirdPartyDeveloperTool(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  toolName: string;
  paramsJson?: string;
  toolParams?: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<ChromeMcpGenericToolResult> {
  const result = await callTool(
    params.profileName,
    chromeMcpProfileOptionsFromParams(params),
    "execute_3p_developer_tool",
    {
      pageId: parsePageId(params.targetId),
      toolName: params.toolName,
      ...(params.paramsJson !== undefined
        ? { params: params.paramsJson }
        : params.toolParams !== undefined
          ? { params: JSON.stringify(params.toolParams) }
          : {}),
    },
    { timeoutMs: params.timeoutMs },
  );
  return toGenericToolResult(result);
}

export async function listChromeMcpWebMcpTools(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  timeoutMs?: number;
}): Promise<ChromeMcpGenericToolResult> {
  const result = await callTool(
    params.profileName,
    chromeMcpProfileOptionsFromParams(params),
    "list_webmcp_tools",
    { pageId: parsePageId(params.targetId) },
    { timeoutMs: params.timeoutMs },
  );
  return toGenericToolResult(result);
}

export async function executeChromeMcpWebMcpTool(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  toolName: string;
  inputJson?: string;
  input?: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<ChromeMcpGenericToolResult> {
  const result = await callTool(
    params.profileName,
    chromeMcpProfileOptionsFromParams(params),
    "execute_webmcp_tool",
    {
      pageId: parsePageId(params.targetId),
      toolName: params.toolName,
      ...(params.inputJson !== undefined
        ? { input: params.inputJson }
        : params.input !== undefined
          ? { input: JSON.stringify(params.input) }
          : {}),
    },
    { timeoutMs: params.timeoutMs },
  );
  return toGenericToolResult(result);
}

export async function handleChromeMcpDialog(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  action: "accept" | "dismiss";
  promptText?: string;
  timeoutMs?: number;
}): Promise<void> {
  await callTool(
    params.profileName,
    chromeMcpProfileOptionsFromParams(params),
    "handle_dialog",
    {
      pageId: parsePageId(params.targetId),
      action: params.action,
      ...(params.promptText ? { promptText: params.promptText } : {}),
    },
    { timeoutMs: params.timeoutMs },
  );
}

export async function evaluateChromeMcpScript(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  fn: string;
  args?: string[];
}): Promise<unknown> {
  const result = await callTool(
    params.profileName,
    chromeMcpProfileOptionsFromParams(params),
    "evaluate_script",
    {
      pageId: parsePageId(params.targetId),
      function: params.fn,
      ...(params.args?.length ? { args: params.args } : {}),
    },
  );
  return extractJsonMessage(result);
}

export async function waitForChromeMcpText(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  text: string[];
  timeoutMs?: number;
}): Promise<void> {
  await callTool(params.profileName, chromeMcpProfileOptionsFromParams(params), "wait_for", {
    pageId: parsePageId(params.targetId),
    text: params.text,
    ...(typeof params.timeoutMs === "number" ? { timeout: params.timeoutMs } : {}),
  });
}

export async function listChromeMcpConsoleMessages(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  pageSize?: number;
  pageIdx?: number;
  types?: string[];
  includePreservedMessages?: boolean;
}): Promise<ChromeMcpConsoleMessagesResult> {
  const result = await callTool(
    params.profileName,
    chromeMcpProfileOptionsFromParams(params),
    "list_console_messages",
    {
      pageId: parsePageId(params.targetId),
      ...(typeof params.pageSize === "number" ? { pageSize: params.pageSize } : {}),
      ...(typeof params.pageIdx === "number" ? { pageIdx: params.pageIdx } : {}),
      ...(params.types?.length ? { types: params.types } : {}),
      ...(params.includePreservedMessages ? { includePreservedMessages: true } : {}),
    },
  );
  return extractConsoleMessages(result);
}

export async function getChromeMcpConsoleMessage(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  msgid: number;
}): Promise<ChromeMcpConsoleMessage | null> {
  try {
    const result = await callTool(
      params.profileName,
      chromeMcpProfileOptionsFromParams(params),
      "get_console_message",
      {
        pageId: parsePageId(params.targetId),
        msgid: params.msgid,
      },
    );
    return extractConsoleMessage(result);
  } catch (error) {
    if (!isChromeMcpSelectedPageLookupUnavailable(error)) {
      throw error;
    }
    const fallback = await listChromeMcpConsoleMessages({
      profileName: params.profileName,
      profile: params.profile,
      userDataDir: params.userDataDir,
      targetId: params.targetId,
      includePreservedMessages: true,
    });
    return fallback.messages.find((message) => message.id === params.msgid) ?? null;
  }
}

export async function listChromeMcpNetworkRequests(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  pageSize?: number;
  pageIdx?: number;
  resourceTypes?: string[];
  includePreservedRequests?: boolean;
}): Promise<ChromeMcpNetworkRequestsResult> {
  const result = await callTool(
    params.profileName,
    chromeMcpProfileOptionsFromParams(params),
    "list_network_requests",
    {
      pageId: parsePageId(params.targetId),
      ...(typeof params.pageSize === "number" ? { pageSize: params.pageSize } : {}),
      ...(typeof params.pageIdx === "number" ? { pageIdx: params.pageIdx } : {}),
      ...(params.resourceTypes?.length ? { resourceTypes: params.resourceTypes } : {}),
      ...(params.includePreservedRequests ? { includePreservedRequests: true } : {}),
    },
  );
  return extractNetworkRequests(result);
}

export async function getChromeMcpNetworkRequest(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  reqid?: number;
  requestFilePath?: string;
  responseFilePath?: string;
}): Promise<ChromeMcpNetworkRequest | null> {
  try {
    const result = await callTool(
      params.profileName,
      chromeMcpProfileOptionsFromParams(params),
      "get_network_request",
      {
        pageId: parsePageId(params.targetId),
        ...(typeof params.reqid === "number" ? { reqid: params.reqid } : {}),
        ...(params.requestFilePath ? { requestFilePath: params.requestFilePath } : {}),
        ...(params.responseFilePath ? { responseFilePath: params.responseFilePath } : {}),
      },
    );
    return extractNetworkRequest(result);
  } catch (error) {
    if (!isChromeMcpSelectedPageLookupUnavailable(error) || typeof params.reqid !== "number") {
      throw error;
    }
    const fallback = await listChromeMcpNetworkRequests({
      profileName: params.profileName,
      profile: params.profile,
      userDataDir: params.userDataDir,
      targetId: params.targetId,
      includePreservedRequests: true,
    });
    return (
      fallback.requests.find(
        (request) => request.requestId === params.reqid || Number(request.id) === params.reqid,
      ) ?? null
    );
  }
}

export function setChromeMcpSessionFactoryForTest(factory: ChromeMcpSessionFactory | null): void {
  sessionFactory = factory;
}

export function setChromeMcpProcessCleanupDepsForTest(
  deps: ChromeMcpProcessCleanupDeps | null,
): void {
  chromeMcpProcessCleanupDepsForTest = deps;
}

export async function resetChromeMcpSessionsForTest(): Promise<void> {
  sessionFactory = null;
  pendingSessions.clear();
  emulationStates.clear();
  await stopAllChromeMcpSessions();
  chromeMcpProcessCleanupDepsForTest = null;
}
