import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  installMockFetch,
  restoreFetch,
  mockFetch,
  getFetchCalls,
} from "../helpers/mock-fetch.js";
import { mockExecFile, swaBinaryMatcher } from "../helpers/mock-swa-deploy.js";
import { handler } from "../../src/tools/app-deploy.js";

let tokenDir: string;
let appDir: string;

function mockTokens() {
  return {
    access_token: "test-token",
    storage_access_token: "test-storage-token",
    refresh_token: "test-refresh",
    expires_at: Date.now() + 3600_000,
    storage_expires_at: Date.now() + 3600_000,
  };
}

/** Create a JWT with a UPN claim for testing extractUpn */
function mockTokensWithUpn(upn: string) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ upn })).toString("base64url");
  const sig = "";
  return {
    access_token: `${header}.${payload}.${sig}`,
    storage_access_token: "test-storage-token",
    refresh_token: "test-refresh",
    expires_at: Date.now() + 3600_000,
    storage_expires_at: Date.now() + 3600_000,
  };
}

async function setupTokenDir(tokens?: object): Promise<void> {
  tokenDir = await mkdtemp(join(tmpdir(), "token-"));
  process.env.DEPLOY_AGENT_TOKEN_DIR = tokenDir;
  if (tokens) {
    await writeFile(join(tokenDir, "tokens.json"), JSON.stringify(tokens));
  }
}

async function setupAppDir(
  files: Record<string, string> = { "index.html": "<h1>Hello</h1>" },
): Promise<void> {
  appDir = await mkdtemp(join(tmpdir(), "app-"));
  for (const [name, content] of Object.entries(files)) {
    const dir = join(appDir, name.includes("/") ? name.substring(0, name.lastIndexOf("/")) : "");
    if (name.includes("/")) await mkdir(dir, { recursive: true });
    await writeFile(join(appDir, name), content);
  }
}

/**
 * Mock all blob + deploy calls for the new architecture.
 * registryStatus 404 = empty registry (first deploy), 200 = existing registry.
 */
function mockBlobAndDeployFlow(slug: string, registryStatus: number = 404) {
  // Upload blob files (PUT to blob storage)
  mockFetch((url, init) => {
    if (url.includes(".blob.core.windows.net") && init?.method === "PUT") {
      return { status: 201, body: null };
    }
    return undefined;
  });

  // Download registry.json (GET blob)
  let registryDownloaded = false;
  mockFetch((url, init) => {
    if (
      url.includes(".blob.core.windows.net") &&
      url.includes("registry.json") &&
      (!init?.method || init.method === "GET") &&
      !url.includes("comp=list")
    ) {
      if (!registryDownloaded) {
        registryDownloaded = true;
        if (registryStatus === 404) return { status: 404, body: null };
        return {
          status: 200,
          body: JSON.stringify({
            apps: [
              {
                slug,
                name: "Existing",
                description: "d",
                deployedAt: "t",
                deployedBy: "u",
              },
            ],
          }),
          headers: { "content-type": "application/octet-stream" },
        };
      }
      return undefined;
    }
    return undefined;
  });

  // List blobs (for assembleSite)
  mockFetch((url) => {
    if (url.includes("comp=list")) {
      return {
        status: 200,
        body: `<EnumerationResults><Blobs><Blob><Name>${slug}/index.html</Name></Blob></Blobs></EnumerationResults>`,
        headers: { "content-type": "application/xml" },
      };
    }
    return undefined;
  });

  // Download app blobs (for assembleSite)
  mockFetch((url, init) => {
    if (
      url.includes(".blob.core.windows.net") &&
      url.includes(`${slug}/`) &&
      (!init?.method || init.method === "GET") &&
      !url.includes("comp=list") &&
      !url.includes("registry.json")
    ) {
      return {
        status: 200,
        body: "<h1>App</h1>",
        headers: { "content-type": "application/octet-stream" },
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

describe("app_deploy — first deploy", () => {
  beforeEach(async () => {
    installMockFetch();
    mockFetch(swaBinaryMatcher());
    mockExecFile();
    await setupTokenDir(mockTokens());
    await setupAppDir();
  });

  afterEach(async () => {
    restoreFetch();
    mock.restoreAll();
    delete process.env.DEPLOY_AGENT_TOKEN_DIR;
    await rm(tokenDir, { recursive: true, force: true });
    await rm(appDir, { recursive: true, force: true });
  });

  it("returns error when not authenticated", async () => {
    await rm(join(tokenDir, "tokens.json"), { force: true });

    const result = await handler({
      folder: appDir,
      app_name: "My App",
      app_description: "Desc",
    });
    assert.ok(result.isError);
    assert.ok(
      result.content[0].text.includes("not authenticated") ||
        result.content[0].text.includes("Not authenticated"),
    );
  });

  it("returns error when app_name is missing on first deploy", async () => {
    const result = await handler({ folder: appDir, app_description: "Desc" });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes("app_name"));
  });

  it("returns error when app_description is missing on first deploy", async () => {
    const result = await handler({ folder: appDir, app_name: "My App" });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes("app_description"));
  });

  it("returns error when folder does not exist", async () => {
    const result = await handler({
      folder: "/tmp/nonexistent-folder-xyz",
      app_name: "My App",
      app_description: "Desc",
    });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.toLowerCase().includes("folder"));
  });

  it("uploads files to blob, updates registry, deploys site, writes .deploy.json", async () => {
    mockBlobAndDeployFlow("my-app", 404);

    const result = await handler({
      folder: appDir,
      app_name: "My App",
      app_description: "A test app",
    });

    assert.ok(!result.isError, `Expected success but got: ${result.content[0].text}`);

    // Verify blob upload occurred
    const calls = getFetchCalls();
    const blobPuts = calls.filter(
      (c) => c.url.includes(".blob.core.windows.net") && c.init?.method === "PUT",
    );
    assert.ok(blobPuts.length >= 1, "Should upload at least one file to blob");

    // Verify the app file was uploaded under the slug prefix
    const appUpload = blobPuts.find((c) => c.url.includes("my-app/index.html"));
    assert.ok(appUpload, "Should upload index.html under my-app/ prefix");

    // Verify registry.json was saved (PUT to blob with registry.json in URL)
    const registrySave = blobPuts.find((c) => c.url.includes("registry.json"));
    assert.ok(registrySave, "Should save registry.json to blob");

    // Verify .deploy.json was written
    const deployJson = JSON.parse(await readFile(join(appDir, ".deploy.json"), "utf8"));
    assert.equal(deployJson.appSlug, "my-app");
    assert.equal(deployJson.appName, "My App");
    assert.equal(deployJson.appDescription, "A test app");

    // Verify listSecrets was called (site deploy via SWA client binary)
    const listSecretsCall = calls.find(
      (c) => c.url.includes("/listSecrets") && c.init?.method === "POST",
    );
    assert.ok(listSecretsCall, "Should call listSecrets to get deployment token");
  });

  it("returns URL with path-based pattern", async () => {
    mockBlobAndDeployFlow("my-app", 404);

    const result = await handler({
      folder: appDir,
      app_name: "My App",
      app_description: "A test app",
    });

    assert.ok(!result.isError, `Expected success but got: ${result.content[0].text}`);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.status, "ok");
    assert.equal(body.slug, "my-app");
    assert.ok(
      body.url.includes("ai-apps.env.fidoo.cloud/my-app/"),
      `URL should be path-based, got: ${body.url}`,
    );
  });

  it("includes deployedBy from JWT UPN", async () => {
    // Re-setup tokens with a UPN-bearing JWT
    await rm(join(tokenDir, "tokens.json"), { force: true });
    await writeFile(
      join(tokenDir, "tokens.json"),
      JSON.stringify(mockTokensWithUpn("alice@fidoo.cloud")),
    );

    mockBlobAndDeployFlow("my-app", 404);

    const result = await handler({
      folder: appDir,
      app_name: "My App",
      app_description: "A test app",
    });

    assert.ok(!result.isError, `Expected success but got: ${result.content[0].text}`);

    // Verify the registry save included the UPN as deployedBy
    const calls = getFetchCalls();
    const registryPut = calls.find(
      (c) =>
        c.url.includes(".blob.core.windows.net") &&
        c.url.includes("registry.json") &&
        c.init?.method === "PUT",
    );
    assert.ok(registryPut, "Should save registry");

    // The body is a Uint8Array; decode it to check the registry content
    const body = registryPut!.init!.body;
    const registryJson =
      body instanceof Uint8Array
        ? Buffer.from(body).toString("utf-8")
        : typeof body === "string"
          ? body
          : String(body);
    const registry = JSON.parse(registryJson);
    const entry = registry.apps.find((a: { slug: string }) => a.slug === "my-app");
    assert.ok(entry, "Registry should contain the app entry");
    assert.equal(entry.deployedBy, "alice@fidoo.cloud");
  });
});

describe("app_deploy — missing index.html warning", () => {
  beforeEach(async () => {
    installMockFetch();
    mockFetch(swaBinaryMatcher());
    mockExecFile();
    await setupTokenDir(mockTokens());
  });

  afterEach(async () => {
    restoreFetch();
    mock.restoreAll();
    delete process.env.DEPLOY_AGENT_TOKEN_DIR;
    await rm(tokenDir, { recursive: true, force: true });
    await rm(appDir, { recursive: true, force: true });
  });

  it("returns warning when folder has no index.html (first deploy)", async () => {
    await setupAppDir({ "app.js": "console.log('hi')", "style.css": "body{}" });

    const result = await handler({
      folder: appDir,
      app_name: "No Index",
      app_description: "Missing index",
    });

    assert.ok(result.isError);
    const text = result.content[0].text;
    assert.ok(text.includes("index.html"), "Should mention index.html");
    assert.ok(
      text.includes("app.js") || text.includes("style.css"),
      "Should list the files that were found",
    );
  });

  it("returns warning when folder has no index.html (re-deploy)", async () => {
    await setupAppDir({ "main.js": "console.log('hi')" });
    await writeFile(
      join(appDir, ".deploy.json"),
      JSON.stringify({
        appSlug: "no-index",
        appName: "No Index",
        appDescription: "Missing index",
        resourceId: "",
      }),
    );

    const result = await handler({ folder: appDir });

    assert.ok(result.isError);
    const text = result.content[0].text;
    assert.ok(text.includes("index.html"), "Should mention index.html");
  });

  it("accepts index.html in root (no warning)", async () => {
    await setupAppDir({ "index.html": "<h1>Hello</h1>" });
    mockBlobAndDeployFlow("my-app", 404);

    const result = await handler({
      folder: appDir,
      app_name: "My App",
      app_description: "Has index",
    });

    assert.ok(!result.isError, `Expected success but got: ${result.content[0].text}`);
  });

  it("warns even if index.html exists in a subdirectory but not root", async () => {
    await setupAppDir({ "sub/index.html": "<h1>Nested</h1>" });

    const result = await handler({
      folder: appDir,
      app_name: "Nested Only",
      app_description: "Nested index",
    });

    assert.ok(result.isError);
    const text = result.content[0].text;
    assert.ok(text.includes("index.html"), "Should mention index.html");
    // Should hint about the subdirectory containing index.html
    assert.ok(text.includes("sub"), "Should mention the subdirectory that has index.html");
  });
});

describe("app_deploy — re-deploy", () => {
  beforeEach(async () => {
    installMockFetch();
    mockFetch(swaBinaryMatcher());
    mockExecFile();
    await setupTokenDir(mockTokens());
    await setupAppDir();
  });

  afterEach(async () => {
    restoreFetch();
    mock.restoreAll();
    delete process.env.DEPLOY_AGENT_TOKEN_DIR;
    await rm(tokenDir, { recursive: true, force: true });
    await rm(appDir, { recursive: true, force: true });
  });

  it("reads .deploy.json and deploys without requiring app_name/app_description", async () => {
    await writeFile(
      join(appDir, ".deploy.json"),
      JSON.stringify({
        appSlug: "existing-app",
        appName: "Existing App",
        appDescription: "Already deployed",
        resourceId: "",
      }),
    );

    mockBlobAndDeployFlow("existing-app", 200);

    const result = await handler({ folder: appDir });

    assert.ok(!result.isError, `Expected success but got: ${result.content[0].text}`);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.status, "ok");
    assert.equal(body.slug, "existing-app");
  });

  it("returns URL with path-based pattern", async () => {
    await writeFile(
      join(appDir, ".deploy.json"),
      JSON.stringify({
        appSlug: "existing-app",
        appName: "Existing App",
        appDescription: "Already deployed",
        resourceId: "",
      }),
    );

    mockBlobAndDeployFlow("existing-app", 200);

    const result = await handler({ folder: appDir });

    assert.ok(!result.isError, `Expected success but got: ${result.content[0].text}`);
    const body = JSON.parse(result.content[0].text);
    assert.ok(
      body.url.includes("ai-apps.env.fidoo.cloud/existing-app/"),
      `URL should be path-based, got: ${body.url}`,
    );
  });

  it("ignores app_name/app_description args when .deploy.json exists", async () => {
    await writeFile(
      join(appDir, ".deploy.json"),
      JSON.stringify({
        appSlug: "existing-app",
        appName: "Existing App",
        appDescription: "Already deployed",
        resourceId: "",
      }),
    );

    mockBlobAndDeployFlow("existing-app", 200);

    const result = await handler({
      folder: appDir,
      app_name: "Ignored Name",
      app_description: "Ignored Desc",
    });

    assert.ok(!result.isError, `Expected success but got: ${result.content[0].text}`);
    // Should still deploy to existing-app, not "ignored-name"
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.slug, "existing-app");
    assert.ok(body.url.includes("existing-app"));
  });
});
