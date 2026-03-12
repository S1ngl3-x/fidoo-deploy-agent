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
    assert.equal((calls[0].init?.headers as Record<string, string>)?.["Authorization"], "Bearer vault-token-123");
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
