import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  installMockFetch,
  restoreFetch,
  mockFetch,
  getFetchCalls,
} from "../helpers/mock-fetch.js";
import { mockExecFile, swaBinaryMatcher } from "../helpers/mock-swa-deploy.js";
import { handler } from "../../src/tools/app-update-info.js";

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

function mockUpdateFlow(slug: string) {
  const existingApp = { slug, name: "Old Name", description: "Old desc", deployedAt: "2026-01-01T00:00:00.000Z", deployedBy: "alice@fidoo.cloud" };

  // Download registry.json (loadRegistry)
  mockFetch((url, init) => {
    if (url.includes("registry.json") && (!init?.method || init.method === "GET") && !url.includes("comp=list")) {
      return {
        status: 200,
        body: JSON.stringify({ apps: [existingApp] }),
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
  // listBlobs for assembleSite
  mockFetch((url) => {
    if (url.includes("comp=list")) {
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

describe("app_update_info", () => {
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
    const result = await handler({ app_slug: "my-app", app_name: "New" });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes("Not authenticated"));
  });

  it("returns error when token is expired", async () => {
    await setupTokenDir(mockTokens({ expires_at: Date.now() - 1000 }));
    const result = await handler({ app_slug: "my-app", app_name: "New" });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.toLowerCase().includes("expired"));
  });

  it("returns error when app_slug is missing", async () => {
    await setupTokenDir(mockTokens());
    const result = await handler({ app_name: "New" });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes("app_slug"));
  });

  it("returns error when neither app_name nor app_description provided", async () => {
    await setupTokenDir(mockTokens());
    const result = await handler({ app_slug: "my-app" });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes("app_name") || result.content[0].text.includes("app_description"));
  });

  it("updates name in registry and redeploys site", async () => {
    await setupTokenDir(mockTokens());
    mockUpdateFlow("my-app");

    const result = await handler({ app_slug: "my-app", app_name: "New Name" });
    assert.ok(!result.isError, `Expected success but got: ${result.content[0].text}`);

    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.status, "ok");

    // Verify registry was saved with updated name
    const calls = getFetchCalls();
    const putCalls = calls.filter((c) => c.url.includes("registry.json") && c.init?.method === "PUT");
    assert.equal(putCalls.length, 1);
    const bodyBytes = putCalls[0].init!.body as Uint8Array;
    const savedRegistry = JSON.parse(Buffer.from(bodyBytes).toString("utf-8"));
    const updatedApp = savedRegistry.apps.find((a: any) => a.slug === "my-app");
    assert.equal(updatedApp.name, "New Name");
    assert.equal(updatedApp.description, "Old desc"); // unchanged

    // Verify listSecrets was called (site redeployed via SWA client binary)
    const secretsCalls = calls.filter((c) => c.url.includes("/listSecrets"));
    assert.ok(secretsCalls.length > 0, "Should redeploy site");
  });

  it("updates description in registry and redeploys site", async () => {
    await setupTokenDir(mockTokens());
    mockUpdateFlow("my-app");

    const result = await handler({ app_slug: "my-app", app_description: "New desc" });
    assert.ok(!result.isError);

    const calls = getFetchCalls();
    const putCalls = calls.filter((c) => c.url.includes("registry.json") && c.init?.method === "PUT");
    const bodyBytes = putCalls[0].init!.body as Uint8Array;
    const savedRegistry = JSON.parse(Buffer.from(bodyBytes).toString("utf-8"));
    const updatedApp = savedRegistry.apps.find((a: any) => a.slug === "my-app");
    assert.equal(updatedApp.name, "Old Name"); // unchanged
    assert.equal(updatedApp.description, "New desc");
  });

  it("updates both name and description", async () => {
    await setupTokenDir(mockTokens());
    mockUpdateFlow("my-app");

    const result = await handler({
      app_slug: "my-app",
      app_name: "New Name",
      app_description: "New desc",
    });
    assert.ok(!result.isError);

    const calls = getFetchCalls();
    const putCalls = calls.filter((c) => c.url.includes("registry.json") && c.init?.method === "PUT");
    const bodyBytes = putCalls[0].init!.body as Uint8Array;
    const savedRegistry = JSON.parse(Buffer.from(bodyBytes).toString("utf-8"));
    const updatedApp = savedRegistry.apps.find((a: any) => a.slug === "my-app");
    assert.equal(updatedApp.name, "New Name");
    assert.equal(updatedApp.description, "New desc");
  });

  it("returns error when app not found in registry", async () => {
    await setupTokenDir(mockTokens());
    // Empty registry
    mockFetch((url, init) => {
      if (url.includes("registry.json") && (!init?.method || init.method === "GET")) {
        return {
          status: 200,
          body: JSON.stringify({ apps: [] }),
          headers: { "content-type": "application/octet-stream" },
        };
      }
      return undefined;
    });

    const result = await handler({ app_slug: "no-such-app", app_name: "New" });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes("not found"));
  });
});
