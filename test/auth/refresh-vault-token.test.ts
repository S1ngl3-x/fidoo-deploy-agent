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
