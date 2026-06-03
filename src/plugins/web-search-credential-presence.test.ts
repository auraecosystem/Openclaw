import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const manifestMetadataMocks = vi.hoisted(() => ({
  loadManifestMetadataSnapshot: vi.fn((): { plugins: unknown[] } => ({ plugins: [] })),
}));

vi.mock("./manifest-contract-eligibility.js", () => ({
  loadManifestMetadataSnapshot: manifestMetadataMocks.loadManifestMetadataSnapshot,
}));

let hasConfiguredWebSearchCredential: typeof import("./web-search-credential-presence.js").hasConfiguredWebSearchCredential;

beforeAll(async () => {
  ({ hasConfiguredWebSearchCredential } = await import("./web-search-credential-presence.js"));
});

describe("hasConfiguredWebSearchCredential", () => {
  beforeEach(() => {
    manifestMetadataMocks.loadManifestMetadataSnapshot.mockReset();
    manifestMetadataMocks.loadManifestMetadataSnapshot.mockReturnValue({ plugins: [] });
  });

  it("does not statically import web-search runtime providers", () => {
    const source = fs.readFileSync(
      path.join(repoRoot, "src/plugins/web-search-credential-presence.ts"),
      "utf8",
    );

    expect(source).not.toMatch(/\bfrom\s+["'][^"']*web-search-providers\.runtime\.js["']/);
    expect(source).not.toMatch(/\bfrom\s+["'][^"']*loader\.js["']/);
  });

  it("keeps empty config and env on the manifest-only path", () => {
    expect(
      hasConfiguredWebSearchCredential({
        config: {} as OpenClawConfig,
        env: {},
        origin: "bundled",
      }),
    ).toBe(false);
  });

  it("detects configured web search credential candidates without runtime loading", () => {
    expect(
      hasConfiguredWebSearchCredential({
        config: {
          tools: { web: { search: { apiKey: "brave-key" } } },
        } as OpenClawConfig,
        env: {},
        origin: "bundled",
      }),
    ).toBe(true);
  });

  it("keeps healthy manifest env credential candidates after unreadable plugin metadata", () => {
    const unreadablePlugin = {
      get origin() {
        throw new Error("web search credential plugin origin getter exploded");
      },
      contracts: {
        webSearchProviders: ["broken"],
      },
    } as never;
    manifestMetadataMocks.loadManifestMetadataSnapshot.mockReturnValue({
      plugins: [
        unreadablePlugin,
        {
          origin: "bundled",
          contracts: {
            webSearchProviders: ["healthy-search"],
          },
          setup: {
            providers: [
              {
                envVars: ["HEALTHY_SEARCH_API_KEY"],
              },
            ],
          },
        },
      ],
    });

    expect(
      hasConfiguredWebSearchCredential({
        config: {} as OpenClawConfig,
        env: {
          HEALTHY_SEARCH_API_KEY: "configured",
        },
        origin: "bundled",
      }),
    ).toBe(true);
  });
});
