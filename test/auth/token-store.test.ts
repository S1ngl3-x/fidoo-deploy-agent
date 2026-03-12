import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  saveTokens,
  loadTokens,
  clearTokens,
  isTokenExpired,
  type StoredTokens,
} from "../../src/auth/token-store.js";

/**
 * All tests use a temp directory for file-fallback storage.
 * We never touch the real keychain in tests.
 */

let tmpDir: string;

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

describe("token-store (file fallback)", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-agent-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("saveTokens creates file and loadTokens reads it back", async () => {
    const tokens = makeTokens();
    await saveTokens(tokens, tmpDir);
    const loaded = await loadTokens(tmpDir);

    assert.deepStrictEqual(loaded, tokens);
  });

  it("loadTokens returns null when no tokens saved", async () => {
    const loaded = await loadTokens(tmpDir);
    assert.equal(loaded, null);
  });

  it("clearTokens removes stored tokens", async () => {
    const tokens = makeTokens();
    await saveTokens(tokens, tmpDir);
    await clearTokens(tmpDir);
    const loaded = await loadTokens(tmpDir);

    assert.equal(loaded, null);
  });

  it("saveTokens creates directory if it does not exist", async () => {
    const nestedDir = path.join(tmpDir, "sub", "dir");
    const tokens = makeTokens();
    await saveTokens(tokens, nestedDir);
    const loaded = await loadTokens(nestedDir);

    assert.deepStrictEqual(loaded, tokens);
  });

  it("token file has restricted permissions (0600)", { skip: process.platform === "win32" ? "Windows ignores Unix file permissions" : false }, async () => {
    const tokens = makeTokens();
    await saveTokens(tokens, nestedDir());
    const filePath = path.join(nestedDir(), "tokens.json");
    const stats = fs.statSync(filePath);
    const mode = stats.mode & 0o777;

    assert.equal(mode, 0o600);

    function nestedDir() {
      return tmpDir;
    }
  });

  it("clearTokens is idempotent (no error when no file)", async () => {
    await assert.doesNotReject(() => clearTokens(tmpDir));
  });

  it("saveTokens overwrites existing tokens", async () => {
    const first = makeTokens({ access_token: "first" });
    const second = makeTokens({ access_token: "second" });

    await saveTokens(first, tmpDir);
    await saveTokens(second, tmpDir);

    const loaded = await loadTokens(tmpDir);
    assert.equal(loaded?.access_token, "second");
  });

  it("loadTokens handles tokens.json without vault fields (backward compat)", async () => {
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
});

describe("isTokenExpired", () => {
  it("returns false for token expiring in the future (beyond safety margin)", () => {
    const tokens = makeTokens({
      expires_at: Date.now() + 10 * 60 * 1000, // 10 minutes from now
    });
    assert.equal(isTokenExpired(tokens), false);
  });

  it("returns true for token already expired", () => {
    const tokens = makeTokens({
      expires_at: Date.now() - 1000, // 1 second ago
    });
    assert.equal(isTokenExpired(tokens), true);
  });

  it("returns true for token expiring within 5-minute safety margin", () => {
    const tokens = makeTokens({
      expires_at: Date.now() + 3 * 60 * 1000, // 3 minutes from now
    });
    assert.equal(isTokenExpired(tokens), true);
  });

  it("returns false for token expiring exactly at safety margin boundary", () => {
    const tokens = makeTokens({
      // Slightly more than 5 minutes to avoid timing flakiness
      expires_at: Date.now() + 5 * 60 * 1000 + 5000,
    });
    assert.equal(isTokenExpired(tokens), false);
  });

  it("returns false when vault fields are missing (backward compat)", () => {
    const tokens = makeTokens(); // no vault fields
    assert.equal(isTokenExpired(tokens), false);
  });
});
