import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const resolverPath = fileURLToPath(new URL("../vault-secret-ref-resolver.ts", import.meta.url));
const manifestPath = fileURLToPath(new URL("../openclaw.plugin.json", import.meta.url));

function runResolver(params: {
  request: unknown;
  env?: Record<string, string>;
}): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", resolverPath],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          VAULT_ADDR: "",
          VAULT_TOKEN: "",
          VAULT_NAMESPACE: "",
          CLAW_VAULT_KV_MOUNT: "",
          CLAW_VAULT_KV_VERSION: "",
          ...(params.env ?? {}),
        },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({ stdout, stderr, code });
    });
    child.stdin.end(`${JSON.stringify(params.request)}\n`);
  });
}

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function startVaultFixture() {
  const requests: Array<{ url?: string; token?: string; namespace?: string }> = [];
  const server = createServer((request, response) => {
    requests.push({
      url: request.url,
      token: request.headers["x-vault-token"]?.toString(),
      namespace: request.headers["x-vault-namespace"]?.toString(),
    });
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        data: {
          data: {
            apiKey: "not-a-real-vault-value",
          },
        },
      }),
    );
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push({
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture server did not bind to a TCP port");
  }
  return {
    requests,
    vaultAddr: `http://127.0.0.1:${address.port}`,
  };
}

describe("plugin manifest", () => {
  it("declares the Vault resolver as a managed Node SecretRef preset", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      secretProviderIntegrations?: Record<string, Record<string, unknown>>;
    };

    expect(manifest.secretProviderIntegrations?.vault).toMatchObject({
      providerAlias: "vault",
      source: "exec",
      command: "${node}",
      args: ["./vault-secret-ref-resolver.js"],
    });
    expect(manifest.secretProviderIntegrations?.vault?.passEnv).not.toContain(
      "CLAW_VAULT_VALUES_JSON",
    );
    expect(manifest.secretProviderIntegrations?.vault?.allowInsecurePath).toBeUndefined();
  });
});

describe("vault SecretRef resolver", () => {
  it("requires Vault auth instead of accepting plaintext inline values", async () => {
    const result = await runResolver({
      request: {
        protocolVersion: 1,
        provider: "vault",
        ids: ["providers/openai/apiKey"],
      },
      env: {
        CLAW_VAULT_VALUES_JSON: JSON.stringify({
          "providers/openai/apiKey": "not-a-real-value",
        }),
      },
    });

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      protocolVersion: 1,
      values: {},
      errors: {
        "providers/openai/apiKey": {
          message: "VAULT_TOKEN is required.",
        },
      },
    });
  });

  it("reads KV v2 secrets from Vault using path and field ids", async () => {
    const fixture = await startVaultFixture();
    const result = await runResolver({
      request: {
        protocolVersion: 1,
        provider: "vault",
        ids: ["providers/openai/apiKey"],
      },
      env: {
        VAULT_ADDR: fixture.vaultAddr,
        VAULT_TOKEN: "not-a-real-auth-header",
        VAULT_NAMESPACE: "team-a",
      },
    });

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      protocolVersion: 1,
      values: {
        "providers/openai/apiKey": "not-a-real-vault-value",
      },
      errors: {},
    });
    expect(fixture.requests).toEqual([
      {
        url: "/v1/secret/data/providers/openai",
        token: "not-a-real-auth-header",
        namespace: "team-a",
      },
    ]);
  });

  it("returns per-id errors when Vault auth is not configured", async () => {
    const result = await runResolver({
      request: {
        protocolVersion: 1,
        provider: "vault",
        ids: ["providers/anthropic/apiKey"],
      },
    });

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      protocolVersion: 1,
      values: {},
      errors: {
        "providers/anthropic/apiKey": {
          message: "VAULT_TOKEN is required.",
        },
      },
    });
  });
});
