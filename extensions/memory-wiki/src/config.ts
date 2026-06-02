import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mapPluginConfigIssues } from "openclaw/plugin-sdk/extension-shared";
import { buildPluginConfigSchema, z, type OpenClawPluginConfigSchema } from "../api.js";

export const WIKI_VAULT_MODES = ["isolated", "bridge", "unsafe-local"] as const;
export const WIKI_RENDER_MODES = ["native", "obsidian"] as const;
export const WIKI_SEARCH_BACKENDS = ["shared", "local"] as const;
export const WIKI_SEARCH_CORPORA = ["wiki", "memory", "all"] as const;

export type WikiVaultMode = (typeof WIKI_VAULT_MODES)[number];
export type WikiRenderMode = (typeof WIKI_RENDER_MODES)[number];
export type WikiSearchBackend = (typeof WIKI_SEARCH_BACKENDS)[number];
export type WikiSearchCorpus = (typeof WIKI_SEARCH_CORPORA)[number];

export type WikiPageKind = "entity" | "concept" | "source" | "synthesis" | "report";

export type WikiPageGroup = {
  kind: WikiPageKind;
  dir: string;
  heading?: string;
};

export type MemoryWikiPluginConfig = {
  vaultMode?: WikiVaultMode;
  vault?: {
    path?: string;
    renderMode?: WikiRenderMode;
  };
  obsidian?: {
    enabled?: boolean;
    useOfficialCli?: boolean;
    vaultName?: string;
    openAfterWrites?: boolean;
  };
  bridge?: {
    enabled?: boolean;
    readMemoryArtifacts?: boolean;
    indexDreamReports?: boolean;
    indexDailyNotes?: boolean;
    indexMemoryRoot?: boolean;
    followMemoryEvents?: boolean;
  };
  unsafeLocal?: {
    allowPrivateMemoryCoreAccess?: boolean;
    paths?: string[];
  };
  ingest?: {
    autoCompile?: boolean;
    maxConcurrentJobs?: number;
    allowUrlIngest?: boolean;
  };
  search?: {
    backend?: WikiSearchBackend;
    corpus?: WikiSearchCorpus;
  };
  pageGroups?: WikiPageGroup[];
  context?: {
    includeCompiledDigestPrompt?: boolean;
  };
  render?: {
    preserveHumanBlocks?: boolean;
    createBacklinks?: boolean;
    createDashboards?: boolean;
  };
};

export type ResolvedMemoryWikiConfig = {
  vaultMode: WikiVaultMode;
  vault: {
    path: string;
    renderMode: WikiRenderMode;
  };
  pageGroups: WikiPageGroup[];
  obsidian: {
    enabled: boolean;
    useOfficialCli: boolean;
    vaultName?: string;
    openAfterWrites: boolean;
  };
  bridge: {
    enabled: boolean;
    readMemoryArtifacts: boolean;
    indexDreamReports: boolean;
    indexDailyNotes: boolean;
    indexMemoryRoot: boolean;
    followMemoryEvents: boolean;
  };
  unsafeLocal: {
    allowPrivateMemoryCoreAccess: boolean;
    paths: string[];
  };
  ingest: {
    autoCompile: boolean;
    maxConcurrentJobs: number;
    allowUrlIngest: boolean;
  };
  search: {
    backend: WikiSearchBackend;
    corpus: WikiSearchCorpus;
  };
  context: {
    includeCompiledDigestPrompt: boolean;
  };
  render: {
    preserveHumanBlocks: boolean;
    createBacklinks: boolean;
    createDashboards: boolean;
  };
};

export const DEFAULT_WIKI_VAULT_MODE: WikiVaultMode = "isolated";
export const DEFAULT_WIKI_RENDER_MODE: WikiRenderMode = "native";
export const DEFAULT_WIKI_SEARCH_BACKEND: WikiSearchBackend = "shared";
export const DEFAULT_WIKI_SEARCH_CORPUS: WikiSearchCorpus = "wiki";

export const DEFAULT_PAGE_GROUPS: WikiPageGroup[] = [
  { kind: "source", dir: "sources", heading: "Sources" },
  { kind: "entity", dir: "entities", heading: "Entities" },
  { kind: "concept", dir: "concepts", heading: "Concepts" },
  { kind: "synthesis", dir: "syntheses", heading: "Syntheses" },
  { kind: "report", dir: "reports", heading: "Reports" },
];

/**
 * Filename for standalone wiki config inside the vault root.
 * Implicit dot-file — hidden from normal file listings.
 */
export const WIKI_PAGE_GROUPS_CONFIG_FILENAME = ".wiki-page-groups.json";

const WikiPageGroupSchema = z.strictObject({
  kind: z.enum(["entity", "concept", "source", "synthesis", "report"]),
  dir: z
    .string()
    .min(1)
    .refine(
      (val) => {
        // Reject absolute paths and path traversal
        if (path.isAbsolute(val)) {
          return false;
        }
        const normalized = path.normalize(val);
        if (normalized.startsWith("..") || normalized.includes(".." + path.sep)) {
          return false;
        }
        return true;
      },
      { message: "dir must be a relative path without traversal (no ..)" },
    ),
  heading: z.string().optional(),
});

const MemoryWikiConfigSource = z.strictObject({
  vaultMode: z.enum(WIKI_VAULT_MODES).optional(),
  vault: z
    .strictObject({
      path: z.string().optional(),
      renderMode: z.enum(WIKI_RENDER_MODES).optional(),
    })
    .optional(),
  obsidian: z
    .strictObject({
      enabled: z.boolean().optional(),
      useOfficialCli: z.boolean().optional(),
      vaultName: z.string().optional(),
      openAfterWrites: z.boolean().optional(),
    })
    .optional(),
  bridge: z
    .strictObject({
      enabled: z.boolean().optional(),
      readMemoryArtifacts: z.boolean().optional(),
      indexDreamReports: z.boolean().optional(),
      indexDailyNotes: z.boolean().optional(),
      indexMemoryRoot: z.boolean().optional(),
      followMemoryEvents: z.boolean().optional(),
    })
    .optional(),
  unsafeLocal: z
    .strictObject({
      allowPrivateMemoryCoreAccess: z.boolean().optional(),
      paths: z.array(z.string()).optional(),
    })
    .optional(),
  ingest: z
    .strictObject({
      autoCompile: z.boolean().optional(),
      maxConcurrentJobs: z.number().int().min(1).optional(),
      allowUrlIngest: z.boolean().optional(),
    })
    .optional(),
  search: z
    .strictObject({
      backend: z.enum(WIKI_SEARCH_BACKENDS).optional(),
      corpus: z.enum(WIKI_SEARCH_CORPORA).optional(),
    })
    .optional(),
  pageGroups: z.array(WikiPageGroupSchema).optional(),
  context: z
    .strictObject({
      includeCompiledDigestPrompt: z.boolean().optional(),
    })
    .optional(),
  render: z
    .strictObject({
      preserveHumanBlocks: z.boolean().optional(),
      createBacklinks: z.boolean().optional(),
      createDashboards: z.boolean().optional(),
    })
    .optional(),
});

const memoryWikiConfigSchemaBase = buildPluginConfigSchema(MemoryWikiConfigSource, {
  safeParse(value: unknown) {
    if (value === undefined) {
      return { success: true, data: resolveMemoryWikiConfig(undefined) };
    }
    const result = MemoryWikiConfigSource.safeParse(value);
    if (result.success) {
      return { success: true, data: resolveMemoryWikiConfig(result.data) };
    }
    return {
      success: false,
      error: {
        issues: mapPluginConfigIssues(result.error.issues),
      },
    };
  },
});

export const memoryWikiConfigSchema: OpenClawPluginConfigSchema = memoryWikiConfigSchemaBase;

function expandHomePath(inputPath: string, homedir: string): string {
  if (inputPath === "~") {
    return homedir;
  }
  if (inputPath.startsWith("~/")) {
    return path.join(homedir, inputPath.slice(2));
  }
  return inputPath;
}

export function resolveDefaultMemoryWikiVaultPath(homedir = os.homedir()): string {
  return path.join(homedir, ".openclaw", "wiki", "main");
}

/**
 * Load extra pageGroups from a standalone JSON file inside the vault root.
 * Silently ignores missing/broken files — i.e. no file = no extra groups.
 */
export function loadExtraPageGroupsFromVault(vaultPath: string): WikiPageGroup[] {
  const configPath = path.join(vaultPath, WIKI_PAGE_GROUPS_CONFIG_FILENAME);
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.pageGroups)) {
      return [];
    }
    return parsed.pageGroups
    .filter((g: unknown) => {
      const result = WikiPageGroupSchema.safeParse(g);
      if (!result.success) {
        return false;
      }
      return true;
    })
    .map((g: WikiPageGroup) =>
      Object.assign({}, g, {
        heading: g.heading ?? g.dir.charAt(0).toUpperCase() + g.dir.slice(1),
      }),
    );
  } catch {
    return [];
  }
}

/**
 * Merge page groups with precedence: user config (openclaw.json) tops,
 * vault config (.wiki-page-groups.json) supplements, built-in defaults
 * fill in any kinds not explicitly configured.
 * Unlike dedup-by-kind, all user and vault groups are preserved to support
 * multiple directories per kind (e.g. multiple synthesis directories).
 * Defaults only fill in kinds that have zero user/vault entries.
 */
export function mergePageGroups(
  userGroups: WikiPageGroup[],
  vaultGroups: WikiPageGroup[],
): WikiPageGroup[] {
  const result: WikiPageGroup[] = [];
  // Keep all user/vault groups — preserve multi-dir per kind
  for (const group of userGroups) {
    result.push(group);
  }
  for (const group of vaultGroups) {
    result.push(group);
  }
  // Only use kind dedup for defaults (don't override user/vault kinds)
  const configuredKinds = new Set<WikiPageKind>();
  for (const group of result) {
    configuredKinds.add(group.kind);
  }
  for (const group of DEFAULT_PAGE_GROUPS) {
    if (!configuredKinds.has(group.kind)) {
      result.push(group);
    }
  }
  return result;
}

export function resolveMemoryWikiConfig(
  config: MemoryWikiPluginConfig | undefined,
  options?: { homedir?: string },
): ResolvedMemoryWikiConfig {
  const homedir = options?.homedir ?? os.homedir();
  const parsed = config ? MemoryWikiConfigSource.safeParse(config) : null;
  const safeConfig = parsed?.success ? parsed.data : (config ?? {});

  // When parse fails, strip pageGroups to prevent invalid dirs from reaching filesystem
  if (parsed && !parsed.success) {
    delete (safeConfig as Record<string, unknown>).pageGroups;
  }

  const vaultPath = expandHomePath(
    safeConfig.vault?.path ?? resolveDefaultMemoryWikiVaultPath(homedir),
    homedir,
  );

  const userGroups: WikiPageGroup[] = (safeConfig.pageGroups ?? []).map((group: WikiPageGroup) =>
    Object.assign({}, group, {
      heading: group.heading ?? group.dir.charAt(0).toUpperCase() + group.dir.slice(1),
    }),
  );

  const vaultGroups: WikiPageGroup[] = loadExtraPageGroupsFromVault(vaultPath);

  return {
    vaultMode: safeConfig.vaultMode ?? DEFAULT_WIKI_VAULT_MODE,
    vault: {
      path: vaultPath,
      renderMode: safeConfig.vault?.renderMode ?? DEFAULT_WIKI_RENDER_MODE,
    },
    obsidian: {
      enabled: safeConfig.obsidian?.enabled ?? false,
      useOfficialCli: safeConfig.obsidian?.useOfficialCli ?? false,
      ...(safeConfig.obsidian?.vaultName ? { vaultName: safeConfig.obsidian.vaultName } : {}),
      openAfterWrites: safeConfig.obsidian?.openAfterWrites ?? false,
    },
    bridge: {
      enabled: safeConfig.bridge?.enabled ?? false,
      readMemoryArtifacts: safeConfig.bridge?.readMemoryArtifacts ?? true,
      indexDreamReports: safeConfig.bridge?.indexDreamReports ?? true,
      indexDailyNotes: safeConfig.bridge?.indexDailyNotes ?? true,
      indexMemoryRoot: safeConfig.bridge?.indexMemoryRoot ?? true,
      followMemoryEvents: safeConfig.bridge?.followMemoryEvents ?? true,
    },
    unsafeLocal: {
      allowPrivateMemoryCoreAccess: safeConfig.unsafeLocal?.allowPrivateMemoryCoreAccess ?? false,
      paths: safeConfig.unsafeLocal?.paths ?? [],
    },
    ingest: {
      autoCompile: safeConfig.ingest?.autoCompile ?? true,
      maxConcurrentJobs: safeConfig.ingest?.maxConcurrentJobs ?? 1,
      allowUrlIngest: safeConfig.ingest?.allowUrlIngest ?? true,
    },
    search: {
      backend: safeConfig.search?.backend ?? DEFAULT_WIKI_SEARCH_BACKEND,
      corpus: safeConfig.search?.corpus ?? DEFAULT_WIKI_SEARCH_CORPUS,
    },
    context: {
      includeCompiledDigestPrompt: safeConfig.context?.includeCompiledDigestPrompt ?? false,
    },
    render: {
      preserveHumanBlocks: safeConfig.render?.preserveHumanBlocks ?? true,
      createBacklinks: safeConfig.render?.createBacklinks ?? true,
      createDashboards: safeConfig.render?.createDashboards ?? true,
    },
    pageGroups: mergePageGroups(userGroups, vaultGroups),
  };
}

/**
 * Find the directory for a given kind from pageGroups.
 * Returns null if no matching kind is configured.
 */
export function findDirForKind(
  pageGroups: WikiPageGroup[],
  kind: WikiPageKind,
): string | null {
  const match = pageGroups.find((g) => g.kind === kind);
  return match ? match.dir : null;
}

/**
 * Build the full list of directories that should exist in the vault.
 * pageGroup dirs + built-in system directories.
 */
export function buildVaultDirectories(pageGroups: WikiPageGroup[]): string[] {
  const groupDirs = pageGroups.map((g) => g.dir);
  const systemDirs = [
    "_attachments",
    "_views",
    ".openclaw-wiki",
    ".openclaw-wiki/locks",
    ".openclaw-wiki/cache",
  ];
  return [...new Set([...groupDirs, ...systemDirs])];
}

/**
 * Get the default directory for creating new pages of a given kind.
 * Falls back to the English default for backward compatibility
 * (only used when kind is not configured in pageGroups).
 */
export function getDefaultDirForKind(
  pageGroups: WikiPageGroup[],
  kind: WikiPageKind,
): string {
  return findDirForKind(pageGroups, kind)
    ?? (kind === "source" ? "sources"
        : kind === "synthesis" ? "syntheses"
        : kind === "report" ? "reports"
        : kind === "entity" ? "entities"
        : kind === "concept" ? "concepts"
        : kind);
}
