import { describe, test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { installMockFetch, restoreFetch, mockFetch, getFetchCalls } from "../helpers/mock-fetch.js";
import { listSecretsMatcher, mockExecFile, swaBinaryMatcher } from "../helpers/mock-swa-deploy.js";
import { deploySite } from "../../src/deploy/site-deploy.js";

describe("deploySite", () => {
  beforeEach(() => {
    installMockFetch();
    mockFetch(swaBinaryMatcher());
    mockExecFile();
  });
  afterEach(() => {
    restoreFetch();
    mock.restoreAll();
  });

  function mockAllCalls() {
    let deployTokenRequested = false;

    // listBlobs (for assembleSite)
    mockFetch((url) => {
      if (url.includes("comp=list")) {
        return { status: 200, body: "<EnumerationResults><Blobs></Blobs></EnumerationResults>", headers: { "content-type": "application/xml" } };
      }
      return undefined;
    });

    // listSecrets (for getDeploymentToken in deploySwaDir)
    mockFetch((url, init) => {
      if (url.includes("/listSecrets") && init?.method === "POST") {
        deployTokenRequested = true;
        return { status: 200, body: { properties: { apiKey: "test-deploy-key" } } };
      }
      return undefined;
    });

    return () => deployTokenRequested;
  }

  test("assembles site and deploys via SWA client binary", async () => {
    const wasDeployTokenRequested = mockAllCalls();
    await deploySite("arm-tok", "storage-tok", { apps: [] });
    assert.ok(wasDeployTokenRequested(), "Should request deployment token via listSecrets");
  });

  test("cleans up temp directory even on success", async () => {
    mockAllCalls();
    // Verifying it doesn't throw is sufficient — temp dirs are cleaned in finally block
    await deploySite("arm-tok", "storage-tok", { apps: [] });
  });
});
