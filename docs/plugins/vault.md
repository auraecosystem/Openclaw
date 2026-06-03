---
summary: "Use the bundled Vault plugin to resolve SecretRefs from HashiCorp Vault"
read_when:
  - You want OpenClaw to read API keys from HashiCorp Vault
  - You are setting up SecretRefs on a local machine or server
  - You need to configure Vault-backed model provider credentials
title: "Vault SecretRefs"
---

# Vault SecretRefs

The bundled Vault plugin lets OpenClaw resolve `exec` SecretRefs from
HashiCorp Vault at Gateway startup and reload time. OpenClaw stores Vault
references in config, keeps resolved values in the in-memory secrets snapshot,
and does not write the resolved API keys back to `openclaw.json`.

Use this when you already run Vault or want model provider keys to live outside
OpenClaw config files. For the SecretRef runtime model, see
[Secrets management](/gateway/secrets).

## Before you begin

You need:

- OpenClaw with the bundled `vault` plugin available
- a reachable Vault server
- a Vault token with read access to the secret paths OpenClaw should resolve
- the environment that starts the Gateway must include `VAULT_ADDR` and
  `VAULT_TOKEN`

The resolver talks to Vault over HTTP from Node. The Gateway does not need the
Vault CLI to resolve SecretRefs.

## Store a provider key in Vault

The default resolver expects KV v2 mounted at `secret`. With those defaults,
this SecretRef id:

```text
providers/openrouter/apiKey
```

reads this Vault field:

```text
secret/data/providers/openrouter -> apiKey
```

One way to create it with the Vault CLI is:

```bash
export OPENROUTER_API_KEY=<openrouter-api-key>
vault kv put secret/providers/openrouter apiKey="$OPENROUTER_API_KEY"
```

Use a scoped client token for OpenClaw, not a root token. For the default KV v2
layout, a minimal policy for model provider keys looks like:

```hcl
path "secret/data/providers/*" {
  capabilities = ["read"]
}
```

## Make Vault visible to the Gateway

For an uncontainerized local Gateway, export Vault settings in the same shell
that starts OpenClaw:

```bash
export VAULT_ADDR=https://vault.example.com
export VAULT_TOKEN=<vault-client-token>
```

Optional settings:

```bash
export VAULT_NAMESPACE=<namespace-name>
export CLAW_VAULT_KV_MOUNT=secret
export CLAW_VAULT_KV_VERSION=2
```

Check what the current shell can see:

```bash
openclaw vault status
```

`openclaw vault status` never prints `VAULT_TOKEN`; it reports only whether the
token is set.

<Warning>
If the Gateway runs as a service, LaunchAgent, systemd unit, scheduled task, or
container, that runtime environment must receive the same Vault variables.
Setting variables in an interactive shell only proves that shell, not the
already-running Gateway.
</Warning>

## Generate and apply a SecretRef plan

Create a plan that maps OpenRouter's model provider API key to Vault:

```bash
openclaw vault setup \
  --plan-out ./vault-secrets-plan.json \
  --openrouter-id providers/openrouter/apiKey
```

Apply and verify the plan:

```bash
openclaw secrets apply --from ./vault-secrets-plan.json --dry-run --allow-exec
openclaw secrets apply --from ./vault-secrets-plan.json --allow-exec
openclaw secrets audit --check --allow-exec
openclaw secrets reload
```

Use `--allow-exec` because the Vault plugin resolves through an OpenClaw-managed
exec SecretRef provider.

If the Gateway is not running yet, start it normally after applying the plan
instead of running `openclaw secrets reload`.

## Configure more provider keys

Built-in shortcuts:

```bash
openclaw vault setup --openai-id providers/openai/apiKey
openclaw vault setup --anthropic-id providers/anthropic/apiKey
openclaw vault setup --openrouter-id providers/openrouter/apiKey
```

Multiple provider keys in one plan:

```bash
openclaw vault setup \
  --plan-out ./vault-secrets-plan.json \
  --openai-id providers/openai/apiKey \
  --anthropic-id providers/anthropic/apiKey \
  --openrouter-id providers/openrouter/apiKey
```

OpenAI-compatible or custom model providers use `--provider-key`:

```bash
openclaw vault setup \
  --plan-out ./vault-secrets-plan.json \
  --provider-key local-openai=providers/local-openai/apiKey \
  --provider-key groq=providers/groq/apiKey
```

Each `--provider-key <provider=id>` writes a SecretRef to
`models.providers.<provider>.apiKey`.

## SecretRef id format

Vault SecretRef ids use this convention:

```text
<vault-secret-path>/<field>
```

Examples:

| SecretRef id                  | Default KV v2 Vault read           | Returned field |
| ----------------------------- | ---------------------------------- | -------------- |
| `providers/openrouter/apiKey` | `secret/data/providers/openrouter` | `apiKey`       |
| `providers/openai/apiKey`     | `secret/data/providers/openai`     | `apiKey`       |
| `teams/agent-prod/openrouter` | `secret/data/teams/agent-prod`     | `openrouter`   |

The returned Vault field must be a string.

For KV v1, set:

```bash
export CLAW_VAULT_KV_VERSION=1
```

Then `providers/openrouter/apiKey` reads:

```text
secret/providers/openrouter -> apiKey
```

## What OpenClaw stores

Applying a Vault setup plan stores a plugin-managed provider:

```json
{
  "source": "exec",
  "pluginIntegration": {
    "pluginId": "vault",
    "integrationId": "vault"
  }
}
```

Credential fields point at that provider:

```json
{ "source": "exec", "provider": "vault", "id": "providers/openrouter/apiKey" }
```

The resolved value lives only in the active runtime secrets snapshot.

## Containers and managed deployments

Containerized Gateways still use the same plugin and SecretRef config. The
container must receive:

- `VAULT_ADDR`
- `VAULT_TOKEN`, or another deployment-specific mechanism that provides a
  token before SecretRef resolution
- optional `VAULT_NAMESPACE`, `CLAW_VAULT_KV_MOUNT`, and
  `CLAW_VAULT_KV_VERSION`

When using Kubernetes or OpenShift, store the Vault token in a Kubernetes Secret
and expose it to the Gateway container as `VAULT_TOKEN`. If your deployment
uses the OpenClaw installer, use its external secret provider options rather
than duplicating a manual `secrets.providers.vault` entry.

## Troubleshooting

`openclaw vault status` says `VAULT_TOKEN: not set`:

- Export `VAULT_TOKEN` in the current shell.
- If the Gateway runs as a managed service, update the service environment and
  restart the service.

Vault returns 403:

- Use a client token with `read` access to the exact Vault paths.
- For default KV v2, policy paths usually look like
  `secret/data/providers/*`, not `secret/providers/*`.

Vault returns 404 or the field is missing:

- Check `CLAW_VAULT_KV_MOUNT`, `CLAW_VAULT_KV_VERSION`, the secret path, and
  the field name.
- For the OpenRouter example, create the secret with
  `vault kv put secret/providers/openrouter apiKey="$OPENROUTER_API_KEY"`.

`secrets apply` rejects the plan:

- Plans containing exec providers require `--allow-exec` in write mode.
- Dry-runs skip exec checks unless `--allow-exec` is set.

## Related

- [Secrets management](/gateway/secrets)
- [`openclaw secrets`](/cli/secrets)
- [Plugin inventory](/plugins/plugin-inventory)
