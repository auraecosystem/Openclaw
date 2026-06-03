import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  resolveInlineProviderApiKeyUsageId,
} from "./auth-profiles.js";
import { clearCurrentProviderAuthState } from "./model-provider-auth.js";
import { runProviderAuthWarmWorkerInput } from "./model-provider-auth.worker.js";

const tempDirs: string[] = [];
const envKeys = ["OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY", "OPENCLAW_STATE_DIR"] as const;

function restoreEnv(previous: Record<(typeof envKeys)[number], string | undefined>): void {
  for (const key of envKeys) {
    if (previous[key] === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = previous[key];
  }
}

describe("provider auth warm worker", () => {
  afterEach(() => {
    clearCurrentProviderAuthState();
    clearRuntimeAuthProfileStoreSnapshots();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves runtime-only auth profile snapshots in the worker warm input", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-provider-auth-worker-"));
    tempDirs.push(root);
    const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]])) as Record<
      (typeof envKeys)[number],
      string | undefined
    >;
    process.env.OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY = "1";
    process.env.OPENCLAW_STATE_DIR = path.join(root, "state");

    try {
      const agentDir = path.join(root, "agent");
      const cfg = {
        agents: { list: [{ id: "main", agentDir }] },
        models: {
          providers: {
            "runtime-only": {
              baseUrl: "https://example.com/v1",
              api: "openai",
              models: [{ id: "runtime-model", name: "Runtime Model" }],
            },
          },
        },
      } as unknown as OpenClawConfig;
      const result = await runProviderAuthWarmWorkerInput({
        cfg,
        runtimeAuthStores: [
          {
            agentDir,
            store: {
              version: 1,
              profiles: {
                "runtime-only:default": {
                  type: "api_key",
                  provider: "runtime-only",
                },
              },
            },
          },
        ],
      });

      expect(result.status).toBe("ok");
      if (result.status !== "ok") {
        return;
      }
      expect(result.snapshot.agents[0]?.providers).toContainEqual(["runtime-only", true]);
    } finally {
      restoreEnv(previousEnv);
    }
  }, 30_000);

  it("respects cooled-down inline api keys in the worker warm input", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-provider-auth-worker-cooldown-"));
    tempDirs.push(root);
    const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]])) as Record<
      (typeof envKeys)[number],
      string | undefined
    >;
    process.env.OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY = "1";
    process.env.OPENCLAW_STATE_DIR = path.join(root, "state");

    try {
      const agentDir = path.join(root, "agent");
      const cfg = {
        agents: { list: [{ id: "main", agentDir }] },
        models: {
          providers: {
            "cooled-down": {
              apiKey: "some-key",
              baseUrl: "https://example.com/v1",
              api: "openai",
              models: [{ id: "some-model", name: "Some Model" }],
            },
          },
        },
      } as unknown as OpenClawConfig;

      const usageId = resolveInlineProviderApiKeyUsageId("cooled-down");
      const result = await runProviderAuthWarmWorkerInput({
        cfg,
        runtimeAuthStores: [
          {
            agentDir,
            store: {
              version: 1,
              profiles: {},
              usageStats: {
                [usageId]: {
                  disabledUntil: Date.now() + 60_000,
                  disabledReason: "billing",
                },
              },
            },
          },
        ],
      });

      expect(result.status).toBe("ok");
      if (result.status !== "ok") {
        return;
      }
      // Should NOT contain the provider because the inline key is in cooldown
      expect(result.snapshot.agents[0]?.providers).not.toContainEqual(["cooled-down", true]);
    } finally {
      restoreEnv(previousEnv);
    }
  }, 30_000);
});
