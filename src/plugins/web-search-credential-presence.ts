import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadManifestMetadataSnapshot } from "./manifest-contract-eligibility.js";
import type { PluginManifestRecord } from "./manifest-registry.js";

type WebSearchCredentialPluginMetadata = Pick<
  PluginManifestRecord,
  "origin" | "contracts" | "setup" | "providerAuthEnvVars"
>;

function hasConfiguredCredentialValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return value !== undefined && value !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasConfiguredSearchCredentialCandidate(searchConfig: unknown): boolean {
  if (!isRecord(searchConfig)) {
    return false;
  }
  return Object.entries(searchConfig).some(
    ([key, value]) => key !== "enabled" && hasConfiguredCredentialValue(value),
  );
}

function hasConfiguredPluginWebSearchCandidate(config: OpenClawConfig): boolean {
  const entries = isRecord(config.plugins?.entries) ? config.plugins.entries : undefined;
  if (!entries) {
    return false;
  }
  return Object.values(entries).some((entry) => {
    const pluginConfig = isRecord(entry) ? entry.config : undefined;
    return isRecord(pluginConfig) && hasConfiguredSearchCredentialCandidate(pluginConfig.webSearch);
  });
}

function readWebSearchCredentialPluginMetadata(
  plugin: PluginManifestRecord,
): WebSearchCredentialPluginMetadata | undefined {
  try {
    return {
      origin: plugin.origin,
      contracts: plugin.contracts,
      setup: plugin.setup,
      providerAuthEnvVars: plugin.providerAuthEnvVars,
    };
  } catch {
    return undefined;
  }
}

function hasManifestWebSearchEnvCredentialCandidate(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  origin?: PluginManifestRecord["origin"];
}): boolean {
  const env = params.env;
  if (!env) {
    return false;
  }
  const snapshot = loadManifestMetadataSnapshot({
    config: params.config,
    env,
  });
  for (const snapshotPlugin of snapshot.plugins) {
    const plugin = readWebSearchCredentialPluginMetadata(snapshotPlugin);
    if (!plugin) {
      continue;
    }
    if (params.origin && plugin.origin !== params.origin) {
      continue;
    }
    if ((plugin.contracts?.webSearchProviders?.length ?? 0) === 0) {
      continue;
    }
    const envVars = [
      ...(plugin.setup?.providers ?? []).flatMap((provider) => provider.envVars ?? []),
      ...Object.values(plugin.providerAuthEnvVars ?? {}).flat(),
    ];
    if (envVars.some((envVar) => hasConfiguredCredentialValue(env[envVar]))) {
      return true;
    }
  }
  return false;
}

export function hasConfiguredWebSearchCredential(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  searchConfig?: Record<string, unknown>;
  origin?: PluginManifestRecord["origin"];
}): boolean {
  const searchConfig =
    params.searchConfig ??
    (params.config.tools?.web?.search as Record<string, unknown> | undefined);
  return (
    hasConfiguredSearchCredentialCandidate(searchConfig) ||
    hasConfiguredPluginWebSearchCandidate(params.config) ||
    hasManifestWebSearchEnvCredentialCandidate({
      config: params.config,
      env: params.env,
      origin: params.origin,
    })
  );
}
