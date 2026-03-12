# Key Vault Secret Resolution — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fetch 4 deploy secrets from Azure Key Vault at runtime so `.mcp.json` can be committed secret-free.

**Architecture:** New `src/auth/keyvault.ts` fetches secrets via Key Vault REST API. A third OAuth token (vault-scoped) is acquired during `auth_poll` and refreshed in `server.ts` before tool dispatch. `loadSecrets()` in `config.ts` populates config fields in parallel on first tool use. Env var overrides still win.

**Tech Stack:** TypeScript, ESM, Node 22+, zero runtime deps, `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-03-12-keyvault-secrets-design.md`

---

## Chunk 1: Key Vault fetch + config loading

### Task 1: `src/auth/keyvault.ts` — fetchSecret function

**Files:**
- Create: `src/auth/keyvault.ts`
- Create: `test/auth/keyvault.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// test/auth/keyvault.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installMockFetch, restoreFetch, mockFetch, getFetchCalls } from "../helpers/mock-fetch.js";
import { fetchSecret } from "../../src/auth/keyvault.js";

describe("fetchSecret", () => {
  beforeEach(() => installMockFetch());
  afterEach(() => restoreFetch());

  it("fetches secret value from vault", async () => {
    mockFetch((url) => {
      if (url.includes("vault.azure.net/secrets/my-secret")) {
        return { status: 200, body: { value: "s3cret" } };
      }
      return undefined;
    });

    const result = await fetchSecret("myvault", "my-secret", "vault-token-123");
    assert.equal(result, "s3cret");

    const calls = getFetchCalls();
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes("https://myvault.vault.azure.net/secrets/my-secret?api-version=7.4"));
    assert.equal(calls[0].init?.headers?.["Authorization"], "Bearer vault-token-123");
  });

  it("throws on non-200 response", async () => {
    mockFetch((url) => {
      if (url.includes("vault.azure.net")) {
        return { status: 403, body: { error: { code: "Forbidden", message: "Access denied" } } };
      }
      return undefined;
    });

    await assert.rejects(
      () => fetchSecret("myvault", "my-secret", "bad-token"),
      (err: Error) => {
        assert.ok(err.message.includes("403"));
        return true;
      },
    );
  });

  it("throws on missing value in response", async () => {
    mockFetch((url) => {
      if (url.includes("vault.azure.net")) {
        return { status: 200, body: {} };
      }
      return undefined;
    });

    await assert.rejects(
      () => fetchSecret("myvault", "my-secret", "token"),
      (err: Error) => {
        assert.ok(err.message.includes("my-secret"));
        return true;
      },
    );
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npm run build && node --test dist/test/auth/keyvault.test.js
```

Expected: FAIL — `keyvault.js` does not exist.

- [ ] **Step 3: Write implementation**

```typescript
// src/auth/keyvault.ts
export async function fetchSecret(
  vaultName: string,
  secretName: string,
  vaultToken: string,
): Promise<string> {
  const url = `https://${vaultName}.vault.azure.net/secrets/${secretName}?api-version=7.4`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${vaultToken}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Key Vault fetch failed for '${secretName}': ${res.status} ${body}`);
  }

  const data = (await res.json()) as { value?: string };
  if (data.value == null) {
    throw new Error(`Key Vault response missing value for '${secretName}'`);
  }

  return data.value;
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npm run build && node --test dist/test/auth/keyvault.test.js
```

Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/auth/keyvault.ts test/auth/keyvault.test.ts
git commit -m "feat(keyvault): add fetchSecret function with tests"
```

---

### Task 2: `src/config.ts` — add keyVaultName + loadSecrets

**Files:**
- Modify: `src/config.ts`
- Create: `test/auth/load-secrets.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// test/auth/load-secrets.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installMockFetch, restoreFetch, mockFetch, getFetchCalls } from "../helpers/mock-fetch.js";
import { config, loadSecrets, resetSecretsLoaded } from "../../src/config.js";

describe("loadSecrets", () => {
  const saved: Record<string, string> = {};

  beforeEach(() => {
    installMockFetch();
    resetSecretsLoaded();
    // Save and clear secret fields so vault fetch is needed
    for (const f of ["storageKey", "acrAdminPassword", "portalClientSecret", "graphSpClientSecret", "keyVaultName"] as const) {
      saved[f] = (config as any)[f];
    }
  });

  afterEach(() => {
    restoreFetch();
    // Restore original config
    for (const [k, v] of Object.entries(saved)) {
      (config as any)[k] = v;
    }
  });

  it("is a no-op when keyVaultName is empty", async () => {
    (config as any).keyVaultName = "";
    await loadSecrets("some-token");
    assert.equal(getFetchCalls().length, 0);
  });

  it("fetches all 4 secrets in parallel and populates config", async () => {
    (config as any).keyVaultName = "test-vault";
    (config as any).storageKey = "";
    (config as any).acrAdminPassword = "";
    (config as any).portalClientSecret = "";
    (config as any).graphSpClientSecret = "";

    mockFetch((url) => {
      if (url.includes("deploy-storage-key")) return { status: 200, body: { value: "sk-val" } };
      if (url.includes("deploy-acr-admin-password")) return { status: 200, body: { value: "acr-val" } };
      if (url.includes("deploy-portal-client-secret")) return { status: 200, body: { value: "portal-val" } };
      if (url.includes("deploy-graph-sp-client-secret")) return { status: 200, body: { value: "graph-val" } };
      return undefined;
    });

    await loadSecrets("vault-token");

    assert.equal(config.storageKey, "sk-val");
    assert.equal(config.acrAdminPassword, "acr-val");
    assert.equal(config.portalClientSecret, "portal-val");
    assert.equal(config.graphSpClientSecret, "graph-val");
    assert.equal(getFetchCalls().length, 4);
  });

  it("is idempotent — second call is a no-op", async () => {
    (config as any).keyVaultName = "test-vault";
    (config as any).storageKey = "";
    (config as any).acrAdminPassword = "";
    (config as any).portalClientSecret = "";
    (config as any).graphSpClientSecret = "";

    mockFetch(() => ({ status: 200, body: { value: "val" } }));

    await loadSecrets("tok");
    const callsAfterFirst = getFetchCalls().length;
    await loadSecrets("tok");
    assert.equal(getFetchCalls().length, callsAfterFirst); // no new calls
  });

  it("skips fields already populated via env vars", async () => {
    (config as any).keyVaultName = "test-vault";
    (config as any).storageKey = "env-sk";
    (config as any).acrAdminPassword = "env-ap";
    (config as any).portalClientSecret = "env-pc";
    (config as any).graphSpClientSecret = "env-gs";

    mockFetch(() => { throw new Error("Should not fetch"); });

    await loadSecrets("some-token");
    // All fields pre-populated — no fetch calls
    assert.equal(getFetchCalls().length, 0);
  });

  it("fetches only missing secrets (partial env var override)", async () => {
    (config as any).keyVaultName = "test-vault";
    (config as any).storageKey = "env-sk"; // pre-set
    (config as any).acrAdminPassword = "";  // needs fetch
    (config as any).portalClientSecret = "";  // needs fetch
    (config as any).graphSpClientSecret = "env-gs"; // pre-set

    mockFetch((url) => {
      if (url.includes("deploy-acr-admin-password")) return { status: 200, body: { value: "acr-val" } };
      if (url.includes("deploy-portal-client-secret")) return { status: 200, body: { value: "portal-val" } };
      return undefined;
    });

    await loadSecrets("tok");
    assert.equal(config.storageKey, "env-sk"); // preserved
    assert.equal(config.acrAdminPassword, "acr-val"); // fetched
    assert.equal(config.portalClientSecret, "portal-val"); // fetched
    assert.equal(config.graphSpClientSecret, "env-gs"); // preserved
    assert.equal(getFetchCalls().length, 2);
  });

  it("propagates error when one secret fetch fails (secretsLoaded stays false)", async () => {
    (config as any).keyVaultName = "test-vault";
    (config as any).storageKey = "";
    (config as any).acrAdminPassword = "";
    (config as any).portalClientSecret = "";
    (config as any).graphSpClientSecret = "";

    mockFetch((url) => {
      if (url.includes("deploy-storage-key")) return { status: 200, body: { value: "ok" } };
      if (url.includes("deploy-acr-admin-password")) return { status: 403, body: { error: "Forbidden" } };
      return { status: 200, body: { value: "ok" } };
    });

    await assert.rejects(() => loadSecrets("tok"), (err: Error) => {
      assert.ok(err.message.includes("403"));
      return true;
    });

    // secretsLoaded should still be false — next call should retry
    (config as any).storageKey = "";
    (config as any).acrAdminPassword = "";
    (config as any).portalClientSecret = "";
    (config as any).graphSpClientSecret = "";

    mockFetch(() => ({ status: 200, body: { value: "retry-ok" } }));
    await loadSecrets("tok"); // should retry since secretsLoaded is false
    assert.equal(config.storageKey, "retry-ok");
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npm run build && node --test dist/test/auth/load-secrets.test.js
```

Expected: FAIL — `loadSecrets` is not exported from `config.js`.

- [ ] **Step 3: Implement changes to `src/config.ts`**

Add after the existing imports at top of file:

```typescript
import { fetchSecret } from "./auth/keyvault.js";
```

Add `keyVaultName` and `vaultScope` to `buildConfig()` return object (after `graphSpClientSecret`):

```typescript
    keyVaultName:      process.env.DEPLOY_AGENT_KEY_VAULT_NAME      ?? "",
    vaultScope: "https://vault.azure.net/.default offline_access",
```

Add after `export const config = buildConfig();`:

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

  const needed = mapping.filter(([, field]) => !(config as any)[field]);
  if (needed.length === 0) {
    secretsLoaded = true;
    return;
  }

  const results = await Promise.all(
    needed.map(([vaultSecret]) =>
      fetchSecret(config.keyVaultName, vaultSecret, vaultToken),
    ),
  );

  for (let i = 0; i < needed.length; i++) {
    (config as any)[needed[i][1]] = results[i];
  }

  secretsLoaded = true;
}

/** Test-only: reset the idempotency flag so loadSecrets can be called again. */
export function resetSecretsLoaded(): void {
  secretsLoaded = false;
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npm run build && node --test dist/test/auth/load-secrets.test.js
```

Expected: PASS.

- [ ] **Step 5: Run existing config test to check no regressions**

```bash
node --test dist/test/config.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts test/auth/load-secrets.test.ts
git commit -m "feat(config): add keyVaultName, vaultScope, and loadSecrets"
```

---

## Chunk 2: Token store + auth-poll vault token

### Task 3: `src/auth/token-store.ts` — add optional vault fields

**Files:**
- Modify: `src/auth/token-store.ts`
- Modify: `test/auth/token-store.test.ts`

- [ ] **Step 1: Write failing test for backward compat**

Add to `test/auth/token-store.test.ts` inside the `"token-store (file fallback)"` describe block:

```typescript
  it("loadTokens handles tokens.json without vault fields (backward compat)", async () => {
    // Simulate a pre-keyvault tokens.json
    const oldTokens = {
      access_token: "arm-tok",
      storage_access_token: "storage-tok",
      refresh_token: "refresh-tok",
      expires_at: Date.now() + 3600_000,
      storage_expires_at: Date.now() + 3600_000,
    };
    fs.writeFileSync(
      path.join(tmpDir, "tokens.json"),
      JSON.stringify(oldTokens),
      { mode: 0o600 },
    );

    const loaded = await loadTokens(tmpDir);
    assert.ok(loaded);
    assert.equal(loaded!.access_token, "arm-tok");
    assert.equal(loaded!.vault_access_token, undefined);
    assert.equal(loaded!.vault_expires_at, undefined);
  });
```

Add to the `"isTokenExpired"` describe block:

```typescript
  it("returns false when vault fields are missing (backward compat)", () => {
    const tokens = makeTokens(); // no vault fields
    assert.equal(isTokenExpired(tokens), false);
  });
```

- [ ] **Step 2: Run tests — verify they pass (backward compat test should already pass with optional fields)**

```bash
npm run build && node --test dist/test/auth/token-store.test.js
```

The backward compat test will FAIL because `vault_access_token` is not yet in the `StoredTokens` interface. Actually — it will pass since JS doesn't enforce TS interfaces at runtime. But the `makeTokens` helper doesn't include vault fields, so the isTokenExpired test will already pass. Let's run to confirm.

- [ ] **Step 3: Update `StoredTokens` interface**

In `src/auth/token-store.ts`, change the interface:

```typescript
export interface StoredTokens {
  access_token: string;          // ARM-scoped token
  storage_access_token: string;  // Storage-scoped token
  vault_access_token?: string;   // Key Vault-scoped token (optional for backward compat)
  refresh_token: string;
  expires_at: number;            // Unix timestamp ms (ARM token)
  storage_expires_at: number;    // Unix timestamp ms (storage token)
  vault_expires_at?: number;     // Unix timestamp ms (vault token, optional for backward compat)
}
```

- [ ] **Step 4: Update `makeTokens` in test to support vault fields**

In `test/auth/token-store.test.ts`, update the helper:

```typescript
function makeTokens(overrides?: Partial<StoredTokens>): StoredTokens {
  return {
    access_token: "access123",
    storage_access_token: "storage123",
    refresh_token: "refresh456",
    expires_at: Date.now() + 3600 * 1000,
    storage_expires_at: Date.now() + 3600 * 1000,
    ...overrides,
  };
}
```

(No change needed — spread of `undefined` vault fields correctly leaves them absent.)

- [ ] **Step 5: Add test for saving and loading vault fields**

Add to `"token-store (file fallback)"` describe block:

```typescript
  it("saveTokens persists vault fields and loadTokens reads them back", async () => {
    const tokens = makeTokens({
      vault_access_token: "vault-tok",
      vault_expires_at: Date.now() + 3600_000,
    });
    await saveTokens(tokens, tmpDir);
    const loaded = await loadTokens(tmpDir);
    assert.equal(loaded!.vault_access_token, "vault-tok");
    assert.ok(loaded!.vault_expires_at);
  });
```

- [ ] **Step 6: Run all token-store tests**

```bash
npm run build && node --test dist/test/auth/token-store.test.js
```

Expected: All PASS.

- [ ] **Step 7: Commit**

```bash
git add src/auth/token-store.ts test/auth/token-store.test.ts
git commit -m "feat(token-store): add optional vault token fields (backward compat)"
```

---

### Task 4: `src/tools/auth-poll.ts` — acquire vault token during login

**Files:**
- Modify: `src/tools/auth-poll.ts`
- Modify: `test/tools/auth-tools.test.ts`

- [ ] **Step 1: Update auth_poll test mock to expect 3 token exchanges**

In `test/tools/auth-tools.test.ts`, replace the `"polls for token, saves it, and returns success"` test:

```typescript
  it("polls for token, saves it, and returns success", async () => {
    let callCount = 0;
    mockFetch((url, init) => {
      if (url.includes("/token")) {
        callCount++;
        const body = typeof init?.body === "string" ? init.body : "";

        // First call: device code poll → ARM token
        if (body.includes("device_code")) {
          return {
            status: 200,
            body: {
              access_token: "access-new",
              refresh_token: "refresh-new",
              expires_in: 3600,
              token_type: "Bearer",
            },
          };
        }

        // Refresh token exchanges (storage then vault)
        if (body.includes("grant_type=refresh_token")) {
          if (body.includes("storage.azure.com")) {
            return {
              status: 200,
              body: {
                access_token: "storage-new",
                refresh_token: "refresh-updated",
                expires_in: 3600,
                token_type: "Bearer",
              },
            };
          }
          if (body.includes("vault.azure.net")) {
            return {
              status: 200,
              body: {
                access_token: "vault-new",
                refresh_token: "refresh-final",
                expires_in: 3600,
                token_type: "Bearer",
              },
            };
          }
        }

        // Fallback for any unmatched /token call
        return {
          status: 200,
          body: {
            access_token: "fallback",
            refresh_token: "refresh-fallback",
            expires_in: 3600,
            token_type: "Bearer",
          },
        };
      }
      return undefined;
    });

    const result = await authPollHandler({ device_code: "DEV123" });
    const text = result.content[0].text;
    const parsed = JSON.parse(text);

    assert.equal(parsed.status, "authenticated");
    assert.ok(parsed.expires_at);

    // Verify tokens were saved to disk
    const storedRaw = fs.readFileSync(path.join(tmpDir, "tokens.json"), "utf-8");
    const stored = JSON.parse(storedRaw);
    assert.equal(stored.access_token, "access-new");
    assert.equal(stored.storage_access_token, "storage-new");
    assert.equal(stored.vault_access_token, "vault-new");
    assert.ok(stored.vault_expires_at);
    assert.ok(stored.refresh_token);
  });
```

- [ ] **Step 2: Run test — verify it fails**

```bash
npm run build && node --test dist/test/tools/auth-tools.test.js
```

Expected: FAIL — `vault_access_token` is undefined in saved tokens.

- [ ] **Step 3: Implement vault token exchange in `src/tools/auth-poll.ts`**

After the storage token exchange (line 52), add:

```typescript
    // Use refresh token to get a vault-scoped token
    const vaultTokenResponse = await refreshAccessToken(
      config.tenantId,
      config.clientId,
      storageTokenResponse.refresh_token,
      config.vaultScope,
    );
```

Update the `saveTokens` call to include vault fields:

```typescript
    const armExpiresAt = Date.now() + armTokenResponse.expires_in * 1000;
    const storageExpiresAt = Date.now() + storageTokenResponse.expires_in * 1000;
    const vaultExpiresAt = Date.now() + vaultTokenResponse.expires_in * 1000;

    await saveTokens({
      access_token: armTokenResponse.access_token,
      storage_access_token: storageTokenResponse.access_token,
      vault_access_token: vaultTokenResponse.access_token,
      refresh_token: vaultTokenResponse.refresh_token,
      expires_at: armExpiresAt,
      storage_expires_at: storageExpiresAt,
      vault_expires_at: vaultExpiresAt,
    });
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npm run build && node --test dist/test/tools/auth-tools.test.js
```

Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/auth-poll.ts test/tools/auth-tools.test.ts
git commit -m "feat(auth-poll): acquire vault-scoped token during login"
```

---

## Chunk 3: Server dispatch + vault token refresh

### Task 5: `src/auth/device-code.ts` — add refreshVaultToken helper

**Files:**
- Modify: `src/auth/device-code.ts`
- Create: `test/auth/refresh-vault-token.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/auth/refresh-vault-token.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  installMockFetch,
  restoreFetch,
  mockFetch,
} from "../helpers/mock-fetch.js";
import { saveTokens, loadTokens } from "../../src/auth/token-store.js";
import { refreshVaultToken } from "../../src/auth/device-code.js";

let tmpDir: string;

describe("refreshVaultToken", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-agent-test-"));
    process.env.DEPLOY_AGENT_TOKEN_DIR = tmpDir;
    installMockFetch();
  });

  afterEach(() => {
    restoreFetch();
    delete process.env.DEPLOY_AGENT_TOKEN_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exchanges refresh token for vault token and persists it", async () => {
    // Pre-populate tokens (simulating existing ARM/Storage tokens)
    await saveTokens({
      access_token: "arm-tok",
      storage_access_token: "storage-tok",
      refresh_token: "old-refresh",
      expires_at: Date.now() + 3600_000,
      storage_expires_at: Date.now() + 3600_000,
    }, tmpDir);

    mockFetch((url, init) => {
      if (url.includes("/token")) {
        return {
          status: 200,
          body: {
            access_token: "new-vault-tok",
            refresh_token: "new-refresh",
            expires_in: 3600,
            token_type: "Bearer",
          },
        };
      }
      return undefined;
    });

    const vaultToken = await refreshVaultToken("old-refresh");
    assert.equal(vaultToken, "new-vault-tok");

    // Verify tokens were merged (ARM/Storage preserved, vault updated)
    const stored = await loadTokens(tmpDir);
    assert.equal(stored!.access_token, "arm-tok");
    assert.equal(stored!.storage_access_token, "storage-tok");
    assert.equal(stored!.vault_access_token, "new-vault-tok");
    assert.ok(stored!.vault_expires_at);
    assert.equal(stored!.refresh_token, "new-refresh");
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
npm run build && node --test dist/test/auth/refresh-vault-token.test.js
```

Expected: FAIL — `refreshVaultToken` is not exported.

- [ ] **Step 3: Implement `refreshVaultToken` in `src/auth/device-code.ts`**

Add imports at top:

```typescript
import { config } from "../config.js";
import { loadTokens, saveTokens } from "./token-store.js";
```

Add at end of file:

```typescript
export async function refreshVaultToken(refreshToken: string): Promise<string> {
  const response = await refreshAccessToken(
    config.tenantId,
    config.clientId,
    refreshToken,
    config.vaultScope,
  );

  // Load-merge-save: preserve existing ARM/Storage tokens, update only vault fields
  const existing = await loadTokens();
  if (existing) {
    await saveTokens({
      ...existing,
      vault_access_token: response.access_token,
      vault_expires_at: Date.now() + response.expires_in * 1000,
      refresh_token: response.refresh_token ?? existing.refresh_token,
    });
  }

  return response.access_token;
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npm run build && node --test dist/test/auth/refresh-vault-token.test.js
```

Expected: PASS.

- [ ] **Step 5: Run existing device-code tests to check no regressions**

```bash
node --test dist/test/auth/device-code.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/auth/device-code.ts test/auth/refresh-vault-token.test.ts
git commit -m "feat(auth): add refreshVaultToken for vault token lifecycle"
```

---

### Task 6: `src/server.ts` — centralize loadSecrets in tool dispatch

**Files:**
- Modify: `src/server.ts`
- Modify: `test/server.test.ts`

- [ ] **Step 1: Write failing test for loadSecrets integration**

Add to `test/server.test.ts`. This requires setting up token storage and vault name config:

```typescript
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { beforeEach, afterEach } from "node:test";
import {
  installMockFetch,
  restoreFetch,
  mockFetch,
  getFetchCalls,
} from "./helpers/mock-fetch.js";
import { saveTokens } from "../src/auth/token-store.js";
import { config, resetSecretsLoaded } from "../src/config.js";
```

Add a new describe block:

```typescript
describe("tools/call secret loading", () => {
  let tmpDir: string;
  const savedConfig: Record<string, string> = {};

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-agent-test-"));
    process.env.DEPLOY_AGENT_TOKEN_DIR = tmpDir;
    for (const f of ["keyVaultName", "storageKey", "acrAdminPassword", "portalClientSecret", "graphSpClientSecret"] as const) {
      savedConfig[f] = (config as any)[f];
    }
    resetSecretsLoaded();
    installMockFetch();
  });

  afterEach(() => {
    restoreFetch();
    delete process.env.DEPLOY_AGENT_TOKEN_DIR;
    for (const [k, v] of Object.entries(savedConfig)) {
      (config as any)[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not call vault for exempt tools (auth_status)", async () => {
    (config as any).keyVaultName = "test-vault";
    await saveTokens({
      access_token: "arm",
      storage_access_token: "storage",
      vault_access_token: "vault",
      refresh_token: "refresh",
      expires_at: Date.now() + 3600_000,
      storage_expires_at: Date.now() + 3600_000,
      vault_expires_at: Date.now() + 3600_000,
    }, tmpDir);

    await handleToolsCall({ name: "auth_status", arguments: {} });

    // auth_status should NOT trigger vault fetch calls
    const vaultCalls = getFetchCalls().filter(c => c.url.includes("vault.azure.net"));
    assert.equal(vaultCalls.length, 0);
  });

  it("calls vault for non-exempt tools when keyVaultName is set", async () => {
    (config as any).keyVaultName = "test-vault";
    // Clear secret fields so loadSecrets will fetch
    (config as any).storageKey = "";
    (config as any).acrAdminPassword = "";
    (config as any).portalClientSecret = "";
    (config as any).graphSpClientSecret = "";

    await saveTokens({
      access_token: "arm",
      storage_access_token: "storage",
      vault_access_token: "vault-tok",
      refresh_token: "refresh",
      expires_at: Date.now() + 3600_000,
      storage_expires_at: Date.now() + 3600_000,
      vault_expires_at: Date.now() + 3600_000,
    }, tmpDir);

    // Mock vault secret fetches + whatever the tool itself calls
    mockFetch((url) => {
      if (url.includes("vault.azure.net")) {
        return { status: 200, body: { value: "secret-val" } };
      }
      // app_list reads registry from blob storage — mock that too
      if (url.includes("blob.core.windows.net")) {
        return { status: 200, body: { apps: [] } };
      }
      return { status: 200, body: {} };
    });

    // resetSecretsLoaded() already called in beforeEach

    await handleToolsCall({ name: "app_list", arguments: {} });

    const vaultCalls = getFetchCalls().filter(c => c.url.includes("vault.azure.net"));
    assert.ok(vaultCalls.length > 0, "Expected vault.azure.net fetch calls for non-exempt tool");
  });
});
```

- [ ] **Step 2: Run test — verify current behavior (should pass since no vault calls happen today)**

```bash
npm run build && node --test dist/test/server.test.js
```

This test should actually pass already. The real verification is that after we add the dispatch logic, exempt tools remain exempt. Let's proceed with the implementation.

- [ ] **Step 3: Implement `handleToolsCall` changes in `src/server.ts`**

Add imports:

```typescript
import { loadTokens } from "./auth/token-store.js";
import { loadSecrets, config } from "./config.js";
import { refreshVaultToken } from "./auth/device-code.js";
```

Replace the `handleToolsCall` function:

```typescript
const EXEMPT_TOOLS = new Set(["auth_login", "auth_poll", "auth_status"]);

export async function handleToolsCall(
  params: Record<string, unknown> | undefined
) {
  const name = (params as { name: string })?.name;
  const args = ((params as { arguments?: Record<string, unknown> })?.arguments) ?? {};

  const tool = toolRegistry.get(name);
  if (!tool) {
    return {
      content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  // Load secrets from Key Vault before dispatching (skip auth tools)
  if (!EXEMPT_TOOLS.has(name) && config.keyVaultName) {
    const tokens = await loadTokens();
    if (tokens) {
      let vaultToken = tokens.vault_access_token;

      // Refresh vault token if missing or expired
      if (!vaultToken || (tokens.vault_expires_at ?? 0) < Date.now()) {
        try {
          vaultToken = await refreshVaultToken(tokens.refresh_token);
        } catch {
          // Vault token refresh failed — proceed without secrets.
          // Tools that need secrets will fail with clear errors downstream.
        }
      }

      if (vaultToken) {
        await loadSecrets(vaultToken);
      }
    }
  }

  return tool.handler(args);
}
```

- [ ] **Step 4: Run all server tests**

```bash
npm run build && node --test dist/test/server.test.js
```

Expected: All PASS.

- [ ] **Step 5: Run full test suite to check no regressions**

```bash
npm run build && npm test
```

Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts test/server.test.ts
git commit -m "feat(server): centralize loadSecrets in tool dispatch with vault token refresh"
```

---

## Chunk 4: Repo cleanup — .mcp.json, .gitignore, delete .mcp.json.example

### Task 7: Re-introduce `.mcp.json` to git (secret-free)

**Files:**
- Modify: `.gitignore` (remove `.mcp.json` line)
- Modify: `.mcp.json` (remove all secret values)
- Delete: `.mcp.json.example`

- [ ] **Step 1: Remove `.mcp.json` from `.gitignore`**

Edit `.gitignore` — remove the `.mcp.json` line.

- [ ] **Step 2: Create the secret-free `.mcp.json`**

Overwrite `.mcp.json` with the secret-free version. Remove these env vars: `DEPLOY_AGENT_ACR_ADMIN_USERNAME`, `DEPLOY_AGENT_ACR_ADMIN_PASSWORD`, `DEPLOY_AGENT_STORAGE_KEY`, `DEPLOY_AGENT_PORTAL_CLIENT_SECRET`, `DEPLOY_AGENT_GRAPH_SP_CLIENT_SECRET`. Add `DEPLOY_AGENT_KEY_VAULT_NAME`.

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

- [ ] **Step 3: Delete `.mcp.json.example`**

```bash
rm .mcp.json.example
```

- [ ] **Step 4: Build and run full test suite**

```bash
npm run build && npm test
```

Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add .gitignore .mcp.json
git rm .mcp.json.example
git commit -m "feat: re-introduce .mcp.json secret-free with Key Vault name, delete .mcp.json.example"
```

---

### Task 8: Update CLAUDE.md env var table

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add `DEPLOY_AGENT_KEY_VAULT_NAME` to the Config Environment Variables table**

Add after the `DEPLOY_AGENT_GRAPH_SP_CLIENT_SECRET` row:

```markdown
| `DEPLOY_AGENT_KEY_VAULT_NAME` | Azure Key Vault name (enables runtime secret resolution) | (optional) |
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add DEPLOY_AGENT_KEY_VAULT_NAME to env var table"
```

---

## Task dependency graph

```
Task 1 (keyvault.ts)
   ↓
Task 2 (config.ts loadSecrets) ← depends on Task 1
   ↓
Task 3 (token-store vault fields) ← independent of Task 2, but ordered for clarity
   ↓
Task 4 (auth-poll vault token) ← depends on Task 3
   ↓
Task 5 (refreshVaultToken) ← depends on Task 3
   ↓
Task 6 (server.ts dispatch) ← depends on Task 2 + Task 5
   ↓
Task 7 (.mcp.json cleanup) ← independent, but last for clean final state
   ↓
Task 8 (CLAUDE.md update) ← independent, final docs cleanup
```

Tasks 1-2 can run in parallel with Task 3. Tasks 4 and 5 depend on Task 3. Task 6 depends on 2 and 5. Tasks 7 and 8 are independent.
