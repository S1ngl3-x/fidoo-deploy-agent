import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// We need to test that config reads from env vars.
// Since config.ts uses top-level `export const config = ...`, we need to
// re-import it fresh for each test. We use dynamic imports with cache busting.

describe("config", () => {
  const ENV_VARS = [
    "DEPLOY_AGENT_TENANT_ID",
    "DEPLOY_AGENT_CLIENT_ID",
    "DEPLOY_AGENT_SUBSCRIPTION_ID",
    "DEPLOY_AGENT_RESOURCE_GROUP",
    "DEPLOY_AGENT_LOCATION",
    "DEPLOY_AGENT_STORAGE_ACCOUNT",
    "DEPLOY_AGENT_CONTAINER_NAME",
    "DEPLOY_AGENT_APP_DOMAIN",
    "DEPLOY_AGENT_SWA_SLUG",
  ];

  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save and clear all DEPLOY_AGENT_ env vars
    for (const key of ENV_VARS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    // Restore env vars
    for (const key of ENV_VARS) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  // Since ES modules cache imports, we test the buildConfig function directly
  it("buildConfig uses hardcoded defaults when no env vars set", async () => {
    const { buildConfig } = await import("../src/config.js");
    const cfg = buildConfig();
    assert.equal(cfg.tenantId, "7d8c4da5-9bcc-48dd-ace3-fb4681cf4277");
    assert.equal(cfg.clientId, "PLACEHOLDER_CLIENT_ID");
    assert.equal(cfg.subscriptionId, "PLACEHOLDER_SUBSCRIPTION_ID");
    assert.equal(cfg.resourceGroup, "rg-published-apps");
    assert.equal(cfg.location, "westeurope");
  });

  it("buildConfig reads tenantId from DEPLOY_AGENT_TENANT_ID", async () => {
    process.env.DEPLOY_AGENT_TENANT_ID = "test-tenant-id";
    const { buildConfig } = await import("../src/config.js");
    const cfg = buildConfig();
    assert.equal(cfg.tenantId, "test-tenant-id");
  });

  it("buildConfig reads clientId from DEPLOY_AGENT_CLIENT_ID", async () => {
    process.env.DEPLOY_AGENT_CLIENT_ID = "test-client-id";
    const { buildConfig } = await import("../src/config.js");
    const cfg = buildConfig();
    assert.equal(cfg.clientId, "test-client-id");
  });

  it("buildConfig reads subscriptionId from DEPLOY_AGENT_SUBSCRIPTION_ID", async () => {
    process.env.DEPLOY_AGENT_SUBSCRIPTION_ID = "test-sub-id";
    const { buildConfig } = await import("../src/config.js");
    const cfg = buildConfig();
    assert.equal(cfg.subscriptionId, "test-sub-id");
  });

  it("buildConfig reads resourceGroup from DEPLOY_AGENT_RESOURCE_GROUP", async () => {
    process.env.DEPLOY_AGENT_RESOURCE_GROUP = "my-rg";
    const { buildConfig } = await import("../src/config.js");
    const cfg = buildConfig();
    assert.equal(cfg.resourceGroup, "my-rg");
  });

  it("buildConfig reads location from DEPLOY_AGENT_LOCATION", async () => {
    process.env.DEPLOY_AGENT_LOCATION = "eastus";
    const { buildConfig } = await import("../src/config.js");
    const cfg = buildConfig();
    assert.equal(cfg.location, "eastus");
  });

  it("has storageAccount from env", async () => {
    process.env.DEPLOY_AGENT_STORAGE_ACCOUNT = "mystore";
    const { buildConfig } = await import("../src/config.js");
    const cfg = buildConfig();
    assert.equal(cfg.storageAccount, "mystore");
  });

  it("has containerName with default", async () => {
    const { buildConfig } = await import("../src/config.js");
    const cfg = buildConfig();
    assert.equal(cfg.containerName, "app-content");
  });

  it("has containerName from env", async () => {
    process.env.DEPLOY_AGENT_CONTAINER_NAME = "custom";
    const { buildConfig } = await import("../src/config.js");
    const cfg = buildConfig();
    assert.equal(cfg.containerName, "custom");
  });

  it("has appDomain with default", async () => {
    const { buildConfig } = await import("../src/config.js");
    const cfg = buildConfig();
    assert.equal(cfg.appDomain, "ai-apps.env.fidoo.cloud");
  });

  it("has appDomain from env", async () => {
    process.env.DEPLOY_AGENT_APP_DOMAIN = "custom.example.com";
    const { buildConfig } = await import("../src/config.js");
    const cfg = buildConfig();
    assert.equal(cfg.appDomain, "custom.example.com");
  });

  it("has swaSlug with default", async () => {
    const { buildConfig } = await import("../src/config.js");
    const cfg = buildConfig();
    assert.equal(cfg.swaSlug, "swa-ai-apps");
  });

  it("has swaSlug from env", async () => {
    process.env.DEPLOY_AGENT_SWA_SLUG = "my-apps";
    const { buildConfig } = await import("../src/config.js");
    const cfg = buildConfig();
    assert.equal(cfg.swaSlug, "my-apps");
  });

  it("does not have dnsZone property", async () => {
    const { buildConfig } = await import("../src/config.js");
    const cfg = buildConfig();
    assert.equal("dnsZone" in cfg, false);
  });

  it("does not have dnsResourceGroup property", async () => {
    const { buildConfig } = await import("../src/config.js");
    const cfg = buildConfig();
    assert.equal("dnsResourceGroup" in cfg, false);
  });

  it("does not have dnsApiVersion property", async () => {
    const { buildConfig } = await import("../src/config.js");
    const cfg = buildConfig();
    assert.equal("dnsApiVersion" in cfg, false);
  });

  it("does not have dashboardSlug property", async () => {
    const { buildConfig } = await import("../src/config.js");
    const cfg = buildConfig();
    assert.equal("dashboardSlug" in cfg, false);
  });

  it("buildConfig preserves non-configurable values", async () => {
    const { buildConfig } = await import("../src/config.js");
    const cfg = buildConfig();
    assert.equal(cfg.armScope, "https://management.azure.com/.default offline_access");
    assert.equal(cfg.storageScope, "https://storage.azure.com/.default offline_access");
    assert.equal(cfg.armBaseUrl, "https://management.azure.com");
    assert.equal(cfg.entraBaseUrl, "https://login.microsoftonline.com");
    assert.equal(cfg.swaApiVersion, "2022-09-01");
    assert.equal(cfg.storageApiVersion, "2024-11-04");
    assert.equal(cfg.swaSkuName, "Free");
    assert.equal(cfg.swaSkuTier, "Free");
  });

  it("portalObjectId defaults to empty string", async () => {
    delete process.env.DEPLOY_AGENT_PORTAL_OBJECT_ID;
    const { buildConfig } = await import("../src/config.js");
    const c = buildConfig();
    assert.equal(c.portalObjectId, "");
  });

  it("graphSpClientId defaults to empty string", async () => {
    delete process.env.DEPLOY_AGENT_GRAPH_SP_CLIENT_ID;
    const { buildConfig } = await import("../src/config.js");
    const c = buildConfig();
    assert.equal(c.graphSpClientId, "");
  });

  it("graphSpClientSecret defaults to empty string", async () => {
    delete process.env.DEPLOY_AGENT_GRAPH_SP_CLIENT_SECRET;
    const { buildConfig } = await import("../src/config.js");
    const c = buildConfig();
    assert.equal(c.graphSpClientSecret, "");
  });

  it("reads portalObjectId from env", async () => {
    process.env.DEPLOY_AGENT_PORTAL_OBJECT_ID = "obj-123";
    const { buildConfig } = await import("../src/config.js");
    const c = buildConfig();
    assert.equal(c.portalObjectId, "obj-123");
    delete process.env.DEPLOY_AGENT_PORTAL_OBJECT_ID;
  });

  it("config export equals buildConfig() result", async () => {
    const { config, buildConfig } = await import("../src/config.js");
    const built = buildConfig();
    // config was built at module load time with current env vars (all cleared)
    assert.equal(config.tenantId, built.tenantId);
    assert.equal(config.resourceGroup, built.resourceGroup);
  });
});
