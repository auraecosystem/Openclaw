#!/usr/bin/env node

type ExecSecretRefRequest = {
  protocolVersion: 1;
  ids: string[];
};

type ExecSecretRefResponse = {
  protocolVersion: 1;
  values: Record<string, string>;
  errors?: Record<string, { message: string }>;
};

type VaultId = {
  secretPath: string;
  field: string;
};

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("error", reject);
    process.stdin.on("end", () => resolve(input));
  });
}

function writeResponse(response: ExecSecretRefResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

function parseRequest(input: string): ExecSecretRefRequest {
  const parsed = JSON.parse(input) as { ids?: unknown };
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.ids)) {
    throw new Error("invalid exec SecretRef request");
  }
  return {
    protocolVersion: 1,
    ids: parsed.ids.filter((id): id is string => typeof id === "string" && id.length > 0),
  };
}

function normalizeVaultAddress(): string {
  const raw = process.env.VAULT_ADDR?.trim();
  if (!raw) {
    throw new Error("VAULT_ADDR is required.");
  }
  return raw.replace(/\/+$/u, "");
}

function resolveVaultToken(): string {
  const token = process.env.VAULT_TOKEN?.trim();
  if (!token) {
    throw new Error("VAULT_TOKEN is required.");
  }
  return token;
}

function resolveKvMount(): string {
  return process.env.CLAW_VAULT_KV_MOUNT?.trim().replace(/^\/+|\/+$/gu, "") || "secret";
}

function resolveKvVersion(): 1 | 2 {
  const raw = process.env.CLAW_VAULT_KV_VERSION?.trim();
  if (!raw || raw === "2") {
    return 2;
  }
  if (raw === "1") {
    return 1;
  }
  throw new Error("CLAW_VAULT_KV_VERSION must be 1 or 2.");
}

function parseVaultId(id: string): VaultId {
  const parts = id.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error(
      `Vault SecretRef id "${id}" must use "<path>/<field>", for example "providers/openai/apiKey".`,
    );
  }
  const field = parts.at(-1);
  if (!field) {
    throw new Error(`Vault SecretRef id "${id}" is missing a field.`);
  }
  return {
    secretPath: parts.slice(0, -1).join("/"),
    field,
  };
}

function encodePath(pathValue: string): string {
  return pathValue
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function buildVaultUrl(params: VaultId): string {
  const mount = encodePath(resolveKvMount());
  const secretPath = encodePath(params.secretPath);
  const base = normalizeVaultAddress();
  if (resolveKvVersion() === 2) {
    return `${base}/v1/${mount}/data/${secretPath}`;
  }
  return `${base}/v1/${mount}/${secretPath}`;
}

function readStringField(payload: unknown, parsedId: VaultId): string {
  const record = payload as { data?: unknown } | undefined;
  const data =
    resolveKvVersion() === 2
      ? (record?.data as { data?: Record<string, unknown> } | undefined)?.data
      : (record?.data as Record<string, unknown> | undefined);
  const value = data?.[parsedId.field];
  if (typeof value !== "string") {
    throw new Error(
      `Vault secret "${parsedId.secretPath}/${parsedId.field}" did not contain a string field "${parsedId.field}".`,
    );
  }
  return value;
}

async function readVaultSecret(id: string): Promise<string> {
  const parsedId = parseVaultId(id);
  const headers: Record<string, string> = {
    "X-Vault-Token": resolveVaultToken(),
  };
  const namespace = process.env.VAULT_NAMESPACE?.trim();
  if (namespace) {
    headers["X-Vault-Namespace"] = namespace;
  }
  const response = await fetch(buildVaultUrl(parsedId), { headers });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Vault read failed for "${id}" (${response.status}): ${body.trim()}`);
  }
  return readStringField(await response.json(), parsedId);
}

async function resolveFromVault(ids: string[]): Promise<ExecSecretRefResponse> {
  const response: ExecSecretRefResponse = { protocolVersion: 1, values: {}, errors: {} };
  await Promise.all(
    ids.map(async (id) => {
      try {
        response.values[id] = await readVaultSecret(id);
      } catch (error) {
        response.errors![id] = {
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  return response;
}

async function main(): Promise<void> {
  const input = await readStdin();
  const request = parseRequest(input);
  writeResponse(await resolveFromVault(request.ids));
}

main().catch((error: unknown) => {
  writeResponse({
    protocolVersion: 1,
    values: {},
    errors: {
      request: {
        message: error instanceof Error ? error.message : String(error),
      },
    },
  });
});
