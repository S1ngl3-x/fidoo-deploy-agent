import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  handleInitialize,
  handleToolsList,
  handleToolsCall,
} from "../src/server.js";
import {
  installMockFetch,
  restoreFetch,
  mockFetch,
  getFetchCalls,
} from "./helpers/mock-fetch.js";
import { saveTokens } from "../src/auth/token-store.js";
import { config, resetSecretsLoaded } from "../src/config.js";

describe("MCP server handlers", () => {
  describe("initialize", () => {
    it("returns correct protocol version and capabilities", async () => {
      const result = await handleInitialize({
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      });

      assert.equal(result.protocolVersion, "2025-11-25");
      assert.deepEqual(result.capabilities, { tools: {} });
      assert.equal(result.serverInfo.name, "deploy-agent");
      assert.equal(typeof result.serverInfo.version, "string");
    });
  });

  describe("tools/list", () => {
    it("returns 10 tools", async () => {
      const result = await handleToolsList();
      assert.equal(result.tools.length, 10);
    });

    it("each tool has name, description, and inputSchema", async () => {
      const result = await handleToolsList();
      for (const tool of result.tools) {
        assert.equal(typeof tool.name, "string");
        assert.equal(typeof tool.description, "string");
        assert.ok(tool.inputSchema);
        assert.equal(tool.inputSchema.type, "object");
      }
    });
  });

  describe("tools/call", () => {
    it("dispatches by name and returns result", async () => {
      const result = await handleToolsCall({
        name: "auth_status",
        arguments: {},
      });
      assert.ok(Array.isArray(result.content));
      assert.equal(result.content[0].type, "text");
    });

    it("returns error for unknown tool", async () => {
      const result = await handleToolsCall({
        name: "nonexistent_tool",
        arguments: {},
      });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes("Unknown tool"));
    });
  });
});

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

    const vaultCalls = getFetchCalls().filter(c => c.url.includes("vault.azure.net"));
    assert.equal(vaultCalls.length, 0);
  });

  it("calls vault for non-exempt tools when keyVaultName is set", async () => {
    (config as any).keyVaultName = "test-vault";
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

    mockFetch((url) => {
      if (url.includes("vault.azure.net")) {
        return { status: 200, body: { value: "secret-val" } };
      }
      // app_list reads registry from blob storage
      if (url.includes("blob.core.windows.net")) {
        return { status: 200, body: { apps: [] } };
      }
      return { status: 200, body: {} };
    });

    await handleToolsCall({ name: "app_list", arguments: {} });

    const vaultCalls = getFetchCalls().filter(c => c.url.includes("vault.azure.net"));
    assert.ok(vaultCalls.length > 0, "Expected vault.azure.net fetch calls for non-exempt tool");
  });
});
