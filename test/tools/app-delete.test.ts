import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installMockFetch, restoreFetch, mockFetch, getFetchCalls } from "../helpers/mock-fetch.js";
import { mockExecFile, swaBinaryMatcher } from "../helpers/mock-swa-deploy.js";
import { handler } from "../../src/tools/app-delete.js";

let tokenDir: string;

function mockTokens(overrides: Partial<{ expires_at: number }> = {}) {
  const exp = overrides.expires_at ?? Date.now() + 3600_000;
  return {
    access_token: "test-token",
    storage_access_token: "test-storage-token",
    refresh_token: "test-refresh",
    expires_at: exp,
    storage_expires_at: exp,
  };
}

async function setupTokenDir(tokens?: object): Promise<void> {
  tokenDir = await mkdtemp(join(tmpdir(), "token-"));
  process.env.DEPLOY_AGENT_TOKEN_DIR = tokenDir;
  if (tokens) {
    await writeFile(join(tokenDir, "tokens.json"), JSON.stringify(tokens));
  }
}

function mockDeleteFlow(slug: string) {
  // listBlobs for deleteBlobsByPrefix
  mockFetch((url) => {
    if (url.includes("comp=list") && url.includes(encodeURIComponent(slug + "/"))) {
      return {
        status: 200,
        body: `<EnumerationResults><Blobs><Blob><Name>${slug}/index.html</Name></Blob></Blobs></EnumerationResults>`,
        headers: { "content-type": "application/xml" },
      };
    }
    return undefined;
  });

  // DELETE blobs
  mockFetch((url, init) => {
    if (url.includes(".blob.core.windows.net") && init?.method === "DELETE") {
      return { status: 202, body: null };
    }
    return undefined;
  });

  // Download registry.json (loadRegistry)
  mockFetch((url, init) => {
    if (url.includes("registry.json") && (!init?.method || init.method === "GET") && !url.includes("comp=list")) {
      return {
        status: 200,
        body: JSON.stringify({ apps: [{ slug, name: "Test", description: "d", deployedAt: "t", deployedBy: "u" }] }),
        headers: { "content-type": "application/octet-stream" },
      };
    }
    return undefined;
  });

  // Upload registry.json (saveRegistry)
  mockFetch((url, init) => {
    if (url.includes("registry.json") && init?.method === "PUT") {
      return { status: 201, body: null };
    }
    return undefined;
  });

  // deploySite mocks:
  // listBlobs for assembleSite (after deletion, the slug should be gone)
  mockFetch((url) => {
    if (url.includes("comp=list") && !url.includes(encodeURIComponent(slug))) {
      return {
        status: 200,
        body: "<EnumerationResults><Blobs></Blobs></EnumerationResults>",
        headers: { "content-type": "application/xml" },
      };
    }
    return undefined;
  });

  // deploySwaDir: getDeploymentToken calls /listSecrets
  mockFetch((url, init) => {
    if (url.includes("/listSecrets") && init?.method === "POST") {
      return { status: 200, body: { properties: { apiKey: "test-deploy-key" } } };
    }
    return undefined;
  });
}

describe("app_delete", () => {
  beforeEach(() => {
    installMockFetch();
    mockFetch(swaBinaryMatcher());
    mockExecFile();
  });

  afterEach(async () => {
    restoreFetch();
    mock.restoreAll();
    delete process.env.DEPLOY_AGENT_TOKEN_DIR;
    if (tokenDir) await rm(tokenDir, { recursive: true, force: true });
  });

  it("returns error when not authenticated", async () => {
    await setupTokenDir();
    const result = await handler({ app_slug: "my-app" });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes("Not authenticated"));
  });

  it("returns error when token is expired", async () => {
    await setupTokenDir(mockTokens({ expires_at: Date.now() - 1000 }));
    const result = await handler({ app_slug: "my-app" });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.toLowerCase().includes("expired"));
  });

  it("returns error when app_slug is missing", async () => {
    await setupTokenDir(mockTokens());
    const result = await handler({});
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes("app_slug"));
  });

  it("deletes blobs, updates registry, and redeploys site", async () => {
    await setupTokenDir(mockTokens());
    mockDeleteFlow("my-app");

    const result = await handler({ app_slug: "my-app" });
    assert.ok(!result.isError, `Expected success but got: ${result.content[0].text}`);

    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.status, "ok");
    assert.ok(parsed.message.includes("my-app"));

    // Verify blob deletion was called
    const calls = getFetchCalls();
    const deleteCalls = calls.filter((c) => c.init?.method === "DELETE");
    assert.ok(deleteCalls.length > 0, "Should have DELETE calls for blob cleanup");

    // Verify listSecrets was called (site redeployed via SWA client binary)
    const secretsCalls = calls.filter((c) => c.url.includes("/listSecrets"));
    assert.ok(secretsCalls.length > 0, "Should redeploy site after delete");
  });

  it("propagates errors from blob operations", async () => {
    await setupTokenDir(mockTokens());
    // Mock listBlobs to fail
    mockFetch((url) => {
      if (url.includes("comp=list")) {
        return { status: 403, body: "Forbidden", headers: { "content-type": "text/plain" } };
      }
      return undefined;
    });

    const result = await handler({ app_slug: "my-app" });
    assert.ok(result.isError);
  });
});
