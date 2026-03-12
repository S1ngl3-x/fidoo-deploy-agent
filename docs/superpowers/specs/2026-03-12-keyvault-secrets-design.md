# Key Vault Secret Resolution

## Problem

The deploy agent requires 4 secrets for container deployments (storage key, ACR admin password, portal client secret, Graph SP client secret). Currently these must be provided as plaintext env vars in `.mcp.json`, which is gitignored. This means:

- Business users installing via marketplace get no `.mcp.json` → plugin doesn't work
- Developers must manually create `.mcp.json` with secrets from Azure Portal
- Secrets sit in plaintext on disk

## Solution

Fetch secrets at runtime from Azure Key Vault. The vault token is acquired alongside ARM and Storage tokens during the existing device code login flow. Secrets are resolved lazily on first tool use and cached in the `config` object for the session — never written to disk.

`.mcp.json` is re-introduced to git with all non-secret config + a vault name. No secrets in the repo, no `.mcp.json.example` needed.

## Design

### New file: `src/auth/keyvault.ts`

Single function:

```typescript
export async function fetchSecret(
  vaultName: string,
  secretName: string,
  vaultToken: string,
): Promise<string>
```

- GET `https://{vaultName}.vault.azure.net/secrets/{secretName}?api-version=7.4`
- Bearer auth with vault token
- Returns the secret value string
- Throws on non-200 with status + error message

### Changed: `src/auth/token-store.ts`

Add vault token fields to `StoredTokens`:

```typescript
export interface StoredTokens {
  access_token: string;          // ARM-scoped
  storage_access_token: string;  // Storage-scoped
  vault_access_token?: string;   // Key Vault-scoped (optional for backward compat)
  refresh_token: string;
  expires_at: number;            // ARM
  storage_expires_at: number;    // Storage
  vault_expires_at?: number;     // Vault (optional for backward compat)
}
```

Vault fields are optional (`?`) so existing `tokens.json` files without them are still valid. When `vault_access_token` is missing or expired, `loadSecrets` triggers a refresh token exchange to acquire it — same pattern as existing ARM/Storage token refresh.

`isTokenExpired` remains unchanged — it only checks ARM and storage expiry. Vault token freshness is checked separately in the `tools/call` handler before calling `loadSecrets` (see `src/server.ts` section below). This avoids breaking `auth_status` for users with pre-existing `tokens.json` files that lack vault fields.

### Changed: `src/auth/device-code.ts` (or `src/tools/auth-poll.ts`)

During `auth_poll`, acquire a third token alongside ARM and Storage. After the storage token exchange succeeds, add:

```typescript
// 3. Exchange refresh token for vault-scoped token
const vaultResponse = await exchangeRefreshToken(
  config.tenantId,
  config.clientId,
  storageResponse.refresh_token,
  "https://vault.azure.net/.default offline_access",
);
```

Update `saveTokens` to include the new fields:

```typescript
saveTokens({
  access_token: armResponse.access_token,
  storage_access_token: storageResponse.access_token,
  vault_access_token: vaultResponse.access_token,
  refresh_token: vaultResponse.refresh_token,
  expires_at: Date.now() + armResponse.expires_in * 1000,
  storage_expires_at: Date.now() + storageResponse.expires_in * 1000,
  vault_expires_at: Date.now() + vaultResponse.expires_in * 1000,
});
```

**Scope assumption:** The Azure CLI well-known client ID (`04b07795-...`) has pre-consented first-party access to `https://vault.azure.net`, so the initial device code request does not need to include vault scope. The refresh token exchange alone is sufficient.

### Changed: `src/config.ts`

Add vault name field:

```typescript
keyVaultName: process.env.DEPLOY_AGENT_KEY_VAULT_NAME ?? "",
```

Add `loadSecrets` function:

```typescript
let secretsLoaded = false;

export async function loadSecrets(vaultToken: string): Promise<void> {
  if (secretsLoaded || !config.keyVaultName) return;

  const mapping: [string, keyof typeof config][] = [
    ["deploy-storage-key", "storageKey"],
    ["deploy-acr-admin-password", "acrAdminPassword"],
    ["deploy-portal-client-secret", "portalClientSecret"],
    ["deploy-graph-sp-client-secret", "graphSpClientSecret"],
  ];

  // Only fetch secrets whose config fields are empty (env var overrides win)
  const needed = mapping.filter(([, field]) => !(config as any)[field]);
  if (needed.length === 0) { secretsLoaded = true; return; }

  const results = await Promise.all(
    needed.map(([vaultSecret]) =>
      fetchSecret(config.keyVaultName, vaultSecret, vaultToken)
    )
  );

  for (let i = 0; i < needed.length; i++) {
    (config as any)[needed[i][1]] = results[i];
  }

  secretsLoaded = true;
}
```

- Only runs when `keyVaultName` is set
- Idempotent — second call is a no-op
- Fetches all needed secrets in parallel (single round-trip)
- Env var overrides win: fields already populated via env vars are skipped
- Mutates `config` via `as any` cast — `config` is not frozen, so this works at runtime. Trade-off: bypasses type safety for simplicity (avoids refactoring `config` to a class with setters)

### Changed: `src/server.ts` (tool dispatch)

Centralize `loadSecrets` in the `tools/call` handler, *before* dispatching to individual tool handlers. This avoids adding a `loadSecrets` call to every tool file:

```typescript
// In tools/call handler, before dispatching to tool.handler:
const EXEMPT_TOOLS = new Set(["auth_login", "auth_poll", "auth_status"]);
if (!EXEMPT_TOOLS.has(name) && config.keyVaultName) {
  const tokens = loadTokens();
  if (tokens) {
    let vaultToken = tokens.vault_access_token;

    // Refresh vault token if missing or expired (timestamps in milliseconds, matching ARM/Storage)
    if (!vaultToken || (tokens.vault_expires_at ?? 0) < Date.now()) {
      vaultToken = await refreshVaultToken(tokens.refresh_token);
    }

    if (vaultToken) {
      await loadSecrets(vaultToken);
    }
  }
}
```

`refreshVaultToken` lives in `src/auth/device-code.ts` alongside the existing `refreshAccessToken`. It:

```typescript
export async function refreshVaultToken(refreshToken: string): Promise<string> {
  const response = await exchangeRefreshToken(
    config.tenantId, config.clientId, refreshToken,
    "https://vault.azure.net/.default offline_access",
  );
  // Load-merge-save: preserve existing ARM/Storage tokens, update only vault fields
  const existing = loadTokens()!;
  saveTokens({
    ...existing,
    vault_access_token: response.access_token,
    vault_expires_at: Date.now() + response.expires_in * 1000,
    refresh_token: response.refresh_token ?? existing.refresh_token,
  });
  return response.access_token;
}
```

This handles the ~1 hour Azure token lifetime — after expiry, the vault token is silently refreshed before secret resolution.

After `loadSecrets` completes, `config.storageKey` etc. work as before — zero changes to any Azure client code or individual tool handlers.

`auth_login`, `auth_poll`, and `auth_status` are exempt (they don't need secrets).

### Changed: `.gitignore`

Remove `.mcp.json` from gitignore.

### Changed: `.mcp.json`

Re-introduced to git. Contains all non-secret config + vault name:

```json
{
  "mcpServers": {
    "deploy-agent": {
      "command": "node",
      "args": ["dist/src/server.js"],
      "type": "stdio",
      "env": {
        "DEPLOY_AGENT_TENANT_ID": "7bcac0ca-0725-4318-9adc-e9b670a48e92",
        "DEPLOY_AGENT_CLIENT_ID": "d98d6d07-48a7-474f-a409-8d2cd1be8c5c",
        "DEPLOY_AGENT_SUBSCRIPTION_ID": "910c52ef-044b-4bd1-b5e9-84700289fca7",
        "DEPLOY_AGENT_RESOURCE_GROUP": "rg-published-apps",
        "DEPLOY_AGENT_STORAGE_ACCOUNT": "fidoovibestorage",
        "DEPLOY_AGENT_CONTAINER_NAME": "app-content",
        "DEPLOY_AGENT_APP_DOMAIN": "ai-apps.env.fidoo.cloud",
        "DEPLOY_AGENT_SWA_SLUG": "swa-ai-apps",
        "DEPLOY_AGENT_LOCATION": "germanywestcentral",
        "DEPLOY_AGENT_CONTAINER_RESOURCE_GROUP": "rg-alipowski-test",
        "DEPLOY_AGENT_CONTAINER_ENV_NAME": "managedEnvironment-rgalipowskitest-adaa",
        "DEPLOY_AGENT_ACR_NAME": "fidooapps",
        "DEPLOY_AGENT_ACR_LOGIN_SERVER": "fidooapps-d4f2bhfjg2fygqg7.azurecr.io",
        "DEPLOY_AGENT_PULL_IDENTITY_ID": "",
        "DEPLOY_AGENT_PORTAL_CLIENT_ID": "e6df67bc-a2b0-47b2-b3fa-8231dbfd3e97",
        "DEPLOY_AGENT_PORTAL_OBJECT_ID": "75d7f2f0-57c8-4673-8d14-08072133caa7",
        "DEPLOY_AGENT_GRAPH_SP_CLIENT_ID": "f1ddd060-33cd-4dd2-9fd4-54382f5c0464",
        "DEPLOY_AGENT_KEY_VAULT_NAME": "kv-fidoo-vibe-deploy2"
      }
    }
  }
}
```

### Deleted: `.mcp.json.example`

Redundant — `.mcp.json` is now the single source of truth.

## Vault secret mapping

| Vault secret name | Config field | Used by |
|---|---|---|
| `deploy-storage-key` | `storageKey` | Blob storage (Shared Key auth), Litestream env var |
| `deploy-acr-admin-password` | `acrAdminPassword` | ACR pull fallback (when no managed identity) |
| `deploy-portal-client-secret` | `portalClientSecret` | Easy Auth portal app secret |
| `deploy-graph-sp-client-secret` | `graphSpClientSecret` | Graph SP for redirect URI management |

## Security properties

- Secrets never written to disk — held in `config` object in memory for the session
- Vault token is persisted (like ARM/Storage tokens) but only grants read access to secrets
- Business users need: membership in `fi-aiapps-pub` group (which they already have) + Key Vault access policy (Secret → Get, one-time admin setup)
- Developers can still override secrets via env vars in their local `.mcp.json` — but this is discouraged since vault works identically in local dev

## Azure prerequisites (one-time admin setup)

1. Key Vault `kv-fidoo-vibe-deploy2` in `rg-alipowski-test` — already created (access policy model)
2. 4 secrets populated — already done
3. Access policy for `fi-aiapps-pub` group: Secret → Get only — **still needed**

## Test plan

- Unit test `keyvault.ts`: mock fetch, verify URL construction, Bearer header, error on non-200 (including 403 vault access denied)
- Unit test `loadSecrets`: mock `fetchSecret`, verify config fields populated, verify idempotent (second call is no-op), verify env var overrides skip vault fetch, verify empty `keyVaultName` is a no-op
- Unit test `loadSecrets` error path: one secret fetch fails → `Promise.all` rejects, `secretsLoaded` stays `false`, error propagates
- Unit test token store: verify vault token fields persisted/loaded, verify missing vault fields (backward compat) don't break `loadTokens`/`isTokenExpired`
- Unit test `server.ts` dispatch: verify `loadSecrets` called for non-exempt tools, skipped for `auth_login`/`auth_poll`/`auth_status`, skipped when `keyVaultName` is empty
- Unit test vault token refresh: verify expired/missing vault token triggers refresh before `loadSecrets`
- Integration: deploy container app with vault-resolved secrets, verify Easy Auth works
