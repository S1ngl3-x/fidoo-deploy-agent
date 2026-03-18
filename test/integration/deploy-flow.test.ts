/**
 * Integration test: full deploy lifecycle through tool handlers.
 *
 * Simulates a realistic sequence using the single-domain blob-based architecture:
 *   auth_status → auth_login → auth_poll → app_deploy (first) →
 *   app_list → app_info → app_update_info → app_deploy (re-deploy) →
 *   app_delete
 *
 * All operations use blob storage + registry.json as the source of truth.
 * No per-app SWA, DNS, or dashboard_rebuild — just blob upload, registry
 * updates, and deploySite (assemble + zip + deploy to single SWA).
 */
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
import { toolRegistry } from "../../src/tools/index.js";

let tokenDir: string;
let appDir: string;

const SLUG = "budget-tracker";

function makeTestJwt(upn: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ upn, sub: "test-sub", exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString("base64url");
  return `${header}.${payload}.fake-signature`;
}

const TEST_TOKEN = makeTestJwt("alice@fidoo.cloud");

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const tool = toolRegistry.get(name);
  assert.ok(tool, `Tool "${name}" not found in registry`);
  return tool.handler(args);
}

function parseResult(result: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
  try {
    return JSON.parse(result.content[0].text);
  } catch {
    return result.content[0].text;
  }
}

describe("integration: full deploy lifecycle (blob + registry)", () => {
  // Stateful registry: tracks what the registry.json contains across operations
  let currentRegistry: { apps: Array<{ slug: string; name: string; description: string; deployedAt: string; deployedBy: string }> };

  beforeEach(async () => {
    installMockFetch();
    mockFetch(swaBinaryMatcher());
    mockExecFile();

    // Initially no registry exists
    currentRegistry = { apps: [] };

    // Set up token dir (empty — not authenticated yet)
    tokenDir = await mkdtemp(join(tmpdir(), "int-token-"));
    process.env.DEPLOY_AGENT_TOKEN_DIR = tokenDir;

    // Set up app dir with sample files
    appDir = await mkdtemp(join(tmpdir(), "int-app-"));
    await writeFile(join(appDir, "index.html"), "<!DOCTYPE html><html><body>Hello</body></html>");
    await mkdir(join(appDir, "css"));
    await writeFile(join(appDir, "css", "style.css"), "body { color: #333; }");
    // Add a file that should be excluded
    await writeFile(join(appDir, ".env"), "SECRET=value");
  });

  afterEach(async () => {
    restoreFetch();
    mock.restoreAll();
    delete process.env.DEPLOY_AGENT_TOKEN_DIR;
    await rm(tokenDir, { recursive: true, force: true });
    await rm(appDir, { recursive: true, force: true });
  });

  it("completes full lifecycle: check auth → login → poll → deploy → list → info → update → redeploy → delete", async () => {
    // Whether this is the first registry GET (returns 404)
    let registryExists = false;

    // ---- Persistent blob + deploy mocks ----

    // Upload blobs (PUT to blob storage — covers file uploads and registry saves)
    mockFetch((url, init) => {
      if (url.includes(".blob.core.windows.net") && init?.method === "PUT") {
        // If this is a registry.json save, capture the saved content
        if (url.includes("registry.json")) {
          const body = init.body;
          const json =
            body instanceof Uint8Array
              ? Buffer.from(body).toString("utf-8")
              : typeof body === "string"
                ? body
                : String(body);
          currentRegistry = JSON.parse(json);
          registryExists = true;
        }
        return { status: 201, body: null };
      }
      return undefined;
    });

    // Download registry.json (GET blob) — returns current stateful registry
    mockFetch((url, init) => {
      if (
        url.includes(".blob.core.windows.net") &&
        url.includes("registry.json") &&
        (!init?.method || init.method === "GET") &&
        !url.includes("comp=list")
      ) {
        if (!registryExists) {
          return { status: 404, body: null };
        }
        return {
          status: 200,
          body: JSON.stringify(currentRegistry),
          headers: { "content-type": "application/octet-stream" },
        };
      }
      return undefined;
    });

    // List blobs (for assembleSite) — returns blobs matching current registry apps
    mockFetch((url) => {
      if (url.includes("comp=list")) {
        const blobEntries = currentRegistry.apps
          .map((app) => `<Blob><Name>${app.slug}/index.html</Name></Blob>`)
          .join("");
        return {
          status: 200,
          body: `<EnumerationResults><Blobs>${blobEntries}</Blobs></EnumerationResults>`,
          headers: { "content-type": "application/xml" },
        };
      }
      return undefined;
    });

    // Download app blobs (for assembleSite — downloading individual app files)
    mockFetch((url, init) => {
      if (
        url.includes(".blob.core.windows.net") &&
        !url.includes("registry.json") &&
        !url.includes("comp=list") &&
        (!init?.method || init.method === "GET")
      ) {
        return {
          status: 200,
          body: "<h1>App</h1>",
          headers: { "content-type": "application/octet-stream" },
        };
      }
      return undefined;
    });

    // DELETE blobs (for app_delete)
    mockFetch((url, init) => {
      if (url.includes(".blob.core.windows.net") && init?.method === "DELETE") {
        return { status: 202, body: null };
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

    // ---- Step 1: auth_status — should be not_authenticated ----
    const statusResult = await callTool("auth_status");
    const statusData = parseResult(statusResult);
    assert.equal(statusData.status, "not_authenticated");

    // ---- Step 2: auth_login — start device code flow ----
    mockFetch((url, init) => {
      if (url.includes("/devicecode") && init?.method === "POST") {
        return {
          status: 200,
          body: {
            device_code: "test-device-code",
            user_code: "ABCD-1234",
            verification_uri: "https://microsoft.com/devicelogin",
            expires_in: 900,
            interval: 5,
            message: "Go to https://microsoft.com/devicelogin and enter ABCD-1234",
          },
        };
      }
      return undefined;
    });

    const loginResult = await callTool("auth_login");
    assert.ok(!loginResult.isError, `auth_login failed: ${loginResult.content[0].text}`);
    const loginData = parseResult(loginResult);
    assert.equal(loginData.user_code, "ABCD-1234");
    assert.equal(loginData.device_code, "test-device-code");

    // ---- Step 3: auth_poll — poll for token ----
    mockFetch((url, init) => {
      if (url.includes("/token") && init?.method === "POST") {
        return {
          status: 200,
          body: {
            access_token: TEST_TOKEN,
            refresh_token: "test-refresh",
            expires_in: 3600,
            token_type: "Bearer",
          },
        };
      }
      return undefined;
    });

    const pollResult = await callTool("auth_poll", { device_code: "test-device-code" });
    assert.ok(!pollResult.isError, `auth_poll failed: ${pollResult.content[0].text}`);
    const pollData = parseResult(pollResult);
    assert.equal(pollData.status, "authenticated");

    // Verify auth_status now shows authenticated
    const statusResult2 = await callTool("auth_status");
    const statusData2 = parseResult(statusResult2);
    assert.equal(statusData2.status, "authenticated");

    // ---- Step 4: app_deploy — first deploy ----
    const deployResult = await callTool("app_deploy", {
      folder: appDir,
      app_name: "Budget Tracker",
      app_description: "Track spending",
    });
    assert.ok(!deployResult.isError, `app_deploy failed: ${deployResult.content[0].text}`);
    const deployData = parseResult(deployResult);
    assert.equal(deployData.slug, SLUG);
    assert.ok(
      deployData.url.includes(`ai-apps.env.fidoo.cloud/${SLUG}/`),
      `URL should be path-based, got: ${deployData.url}`,
    );

    // Verify .deploy.json was written
    const deployJson = JSON.parse(await readFile(join(appDir, ".deploy.json"), "utf8"));
    assert.equal(deployJson.appSlug, SLUG);
    assert.equal(deployJson.appName, "Budget Tracker");
    assert.equal(deployJson.appDescription, "Track spending");

    // Verify blob upload occurred for app files
    const calls = getFetchCalls();
    const blobPuts = calls.filter(
      (c) =>
        c.url.includes(".blob.core.windows.net") &&
        c.init?.method === "PUT" &&
        !c.url.includes("registry.json"),
    );
    assert.ok(blobPuts.length >= 1, "Should upload at least one file to blob");
    const appUpload = blobPuts.find((c) => c.url.includes(`${SLUG}/index.html`));
    assert.ok(appUpload, "Should upload index.html under slug prefix");

    // Verify registry was saved with deployedBy from JWT
    const registrySaves = calls.filter(
      (c) =>
        c.url.includes(".blob.core.windows.net") &&
        c.url.includes("registry.json") &&
        c.init?.method === "PUT",
    );
    assert.ok(registrySaves.length > 0, "Should save registry.json to blob");

    // Verify the stateful registry now contains our app with correct deployedBy
    assert.equal(currentRegistry.apps.length, 1);
    assert.equal(currentRegistry.apps[0].slug, SLUG);
    assert.equal(currentRegistry.apps[0].deployedBy, "alice@fidoo.cloud");

    // Verify listSecrets was called (site deploy via SWA client binary)
    const listSecretsCalls = calls.filter(
      (c) => c.url.includes("/listSecrets") && c.init?.method === "POST",
    );
    assert.ok(listSecretsCalls.length > 0, "Should call listSecrets for site deploy");

    // ---- Step 5: app_list — verify app appears ----
    const listResult = await callTool("app_list");
    assert.ok(!listResult.isError, `app_list failed: ${listResult.content[0].text}`);
    const listData = parseResult(listResult);
    assert.ok(Array.isArray(listData.apps));
    assert.equal(listData.apps.length, 1);
    assert.equal(listData.apps[0].slug, SLUG);
    assert.equal(listData.apps[0].name, "Budget Tracker");
    assert.equal(listData.apps[0].url, `https://ai-apps.env.fidoo.cloud/${SLUG}/`);

    // ---- Step 6: app_info — get details ----
    const infoResult = await callTool("app_info", { app_slug: SLUG });
    assert.ok(!infoResult.isError, `app_info failed: ${infoResult.content[0].text}`);
    const infoData = parseResult(infoResult);
    assert.equal(infoData.slug, SLUG);
    assert.equal(infoData.name, "Budget Tracker");
    assert.equal(infoData.description, "Track spending");
    assert.equal(infoData.url, `https://ai-apps.env.fidoo.cloud/${SLUG}/`);
    assert.equal(infoData.deployedBy, "alice@fidoo.cloud");

    // ---- Step 7: app_update_info — change description ----
    const updateResult = await callTool("app_update_info", {
      app_slug: SLUG,
      app_description: "Track expenses and budgets",
    });
    assert.ok(!updateResult.isError, `app_update_info failed: ${updateResult.content[0].text}`);
    const updateData = parseResult(updateResult);
    assert.equal(updateData.status, "ok");

    // Verify registry was updated with new description
    assert.equal(currentRegistry.apps.length, 1);
    assert.equal(currentRegistry.apps[0].description, "Track expenses and budgets");
    assert.equal(currentRegistry.apps[0].name, "Budget Tracker"); // unchanged

    // ---- Step 8: app_deploy — re-deploy ----
    // .deploy.json exists now, so it should re-deploy without app_name/app_description
    const redeployResult = await callTool("app_deploy", { folder: appDir });
    assert.ok(!redeployResult.isError, `re-deploy failed: ${redeployResult.content[0].text}`);
    const redeployData = parseResult(redeployResult);
    assert.equal(redeployData.slug, SLUG);
    assert.ok(
      redeployData.url.includes(`ai-apps.env.fidoo.cloud/${SLUG}/`),
      `Re-deploy URL should be path-based, got: ${redeployData.url}`,
    );

    // ---- Step 9: app_delete ----
    const deleteResult = await callTool("app_delete", { app_slug: SLUG });
    assert.ok(!deleteResult.isError, `app_delete failed: ${deleteResult.content[0].text}`);
    const deleteData = parseResult(deleteResult);
    assert.ok(deleteData.message.includes(SLUG));

    // Verify registry is now empty (app was removed)
    assert.equal(currentRegistry.apps.length, 0);

    // Verify blob DELETE was called for cleanup
    const allCalls = getFetchCalls();
    const blobDeletes = allCalls.filter(
      (c) => c.url.includes(".blob.core.windows.net") && c.init?.method === "DELETE",
    );
    assert.ok(blobDeletes.length > 0, "Should have DELETE calls for blob cleanup");
  });
});
