import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installMockFetch, restoreFetch, mockFetch } from "../helpers/mock-fetch.js";
import { assembleSite } from "../../src/deploy/assemble.js";
import type { Registry } from "../../src/deploy/registry.js";

describe("assembleSite", () => {
  let outDir: string;
  beforeEach(async () => {
    installMockFetch();
    outDir = await mkdtemp(join(tmpdir(), "assemble-"));
  });
  afterEach(async () => {
    restoreFetch();
    await rm(outDir, { recursive: true, force: true });
  });

  test("creates dashboard index.html at root", async () => {
    mockFetch((url) => {
      if (url.includes("comp=list")) {
        return { status: 200, body: "<EnumerationResults><Blobs></Blobs></EnumerationResults>", headers: { "content-type": "application/xml" } };
      }
      return undefined;
    });
    const registry: Registry = { apps: [] };
    await assembleSite("tok", registry, outDir);
    const html = await readFile(join(outDir, "index.html"), "utf-8");
    assert.ok(html.includes("<!DOCTYPE html>"));
  });

  test("creates registry.json at root", async () => {
    mockFetch((url) => {
      if (url.includes("comp=list")) {
        return { status: 200, body: "<EnumerationResults><Blobs></Blobs></EnumerationResults>", headers: { "content-type": "application/xml" } };
      }
      return undefined;
    });
    const registry: Registry = { apps: [{ slug: "app1", name: "App 1", description: "d", deployedAt: "t", deployedBy: "u" }] };
    await assembleSite("tok", registry, outDir);
    const json = JSON.parse(await readFile(join(outDir, "registry.json"), "utf-8"));
    assert.equal(json.apps.length, 1);
  });

  test("creates staticwebapp.config.json with auth routes", async () => {
    mockFetch((url) => {
      if (url.includes("comp=list")) {
        return { status: 200, body: "<EnumerationResults><Blobs></Blobs></EnumerationResults>", headers: { "content-type": "application/xml" } };
      }
      return undefined;
    });
    const registry: Registry = { apps: [] };
    await assembleSite("tok", registry, outDir);
    const config = JSON.parse(await readFile(join(outDir, "staticwebapp.config.json"), "utf-8"));
    assert.deepEqual(config.routes, [
      { route: "/.auth/*", allowedRoles: ["anonymous"] },
      { route: "/*",       allowedRoles: ["authenticated"] },
    ]);
    assert.deepEqual(config.responseOverrides, {
      "401": { redirect: "/.auth/login/aad?post_login_redirect_uri=.referrer", statusCode: 302 },
    });
  });

  test("downloads app files into slug subdirectory", async () => {
    mockFetch((url, init) => {
      if (url.includes("comp=list")) {
        return {
          status: 200,
          body: `<EnumerationResults><Blobs><Blob><Name>app1/index.html</Name></Blob></Blobs></EnumerationResults>`,
          headers: { "content-type": "application/xml" },
        };
      }
      if (url.includes("app1/index.html") && (!init || init.method === "GET" || !init.method)) {
        return { status: 200, body: "<h1>App 1</h1>", headers: { "content-type": "application/octet-stream" } };
      }
      return undefined;
    });
    const registry: Registry = { apps: [{ slug: "app1", name: "App 1", description: "d", deployedAt: "t", deployedBy: "u" }] };
    await assembleSite("tok", registry, outDir);
    const content = await readFile(join(outDir, "app1", "index.html"), "utf-8");
    assert.ok(content.includes("App 1"));
  });

  test("downloads multiple apps into separate subdirectories", async () => {
    mockFetch((url, init) => {
      if (url.includes("comp=list")) {
        return {
          status: 200,
          body: `<EnumerationResults><Blobs><Blob><Name>app1/index.html</Name></Blob><Blob><Name>app2/style.css</Name></Blob></Blobs></EnumerationResults>`,
          headers: { "content-type": "application/xml" },
        };
      }
      if (url.includes("app1/index.html") && (!init || init.method === "GET" || !init.method)) {
        return { status: 200, body: "<h1>App 1</h1>", headers: { "content-type": "application/octet-stream" } };
      }
      if (url.includes("app2/style.css") && (!init || init.method === "GET" || !init.method)) {
        return { status: 200, body: "body { color: red; }", headers: { "content-type": "application/octet-stream" } };
      }
      return undefined;
    });
    const registry: Registry = {
      apps: [
        { slug: "app1", name: "App 1", description: "d", deployedAt: "t", deployedBy: "u" },
        { slug: "app2", name: "App 2", description: "d", deployedAt: "t", deployedBy: "u" },
      ],
    };
    await assembleSite("tok", registry, outDir);
    const html = await readFile(join(outDir, "app1", "index.html"), "utf-8");
    assert.ok(html.includes("App 1"));
    const css = await readFile(join(outDir, "app2", "style.css"), "utf-8");
    assert.ok(css.includes("color: red"));
  });

  test("skips registry.json blob from download", async () => {
    mockFetch((url, init) => {
      if (url.includes("comp=list")) {
        return {
          status: 200,
          body: `<EnumerationResults><Blobs><Blob><Name>registry.json</Name></Blob><Blob><Name>app1/index.html</Name></Blob></Blobs></EnumerationResults>`,
          headers: { "content-type": "application/xml" },
        };
      }
      if (url.includes("app1/index.html") && (!init || init.method === "GET" || !init.method)) {
        return { status: 200, body: "<h1>App 1</h1>", headers: { "content-type": "application/octet-stream" } };
      }
      // If registry.json is requested for download, fail the test
      if (url.includes("registry.json") && !url.includes("comp=list")) {
        return { status: 200, body: "should not be downloaded", headers: { "content-type": "application/octet-stream" } };
      }
      return undefined;
    });
    const registry: Registry = { apps: [{ slug: "app1", name: "App 1", description: "d", deployedAt: "t", deployedBy: "u" }] };
    await assembleSite("tok", registry, outDir);
    // registry.json at root should contain our passed-in registry, not blob content
    const json = JSON.parse(await readFile(join(outDir, "registry.json"), "utf-8"));
    assert.equal(json.apps[0].slug, "app1");
    // app file should exist
    const html = await readFile(join(outDir, "app1", "index.html"), "utf-8");
    assert.ok(html.includes("App 1"));
  });

  test("handles nested file paths within app", async () => {
    mockFetch((url, init) => {
      if (url.includes("comp=list")) {
        return {
          status: 200,
          body: `<EnumerationResults><Blobs><Blob><Name>app1/assets/js/main.js</Name></Blob></Blobs></EnumerationResults>`,
          headers: { "content-type": "application/xml" },
        };
      }
      if (url.includes("app1/assets/js/main.js") && (!init || init.method === "GET" || !init.method)) {
        return { status: 200, body: "console.log('hi');", headers: { "content-type": "application/octet-stream" } };
      }
      return undefined;
    });
    const registry: Registry = { apps: [{ slug: "app1", name: "App 1", description: "d", deployedAt: "t", deployedBy: "u" }] };
    await assembleSite("tok", registry, outDir);
    const content = await readFile(join(outDir, "app1", "assets", "js", "main.js"), "utf-8");
    assert.ok(content.includes("console.log"));
  });
});
