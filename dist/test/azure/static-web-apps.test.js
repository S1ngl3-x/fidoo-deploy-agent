import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installMockFetch, restoreFetch, mockFetch, getFetchCalls, } from "../helpers/mock-fetch.js";
import { createStaticWebApp, getStaticWebApp, deleteStaticWebApp, listStaticWebApps, getDeploymentToken, updateTags, deploySwaDir, } from "../../src/azure/static-web-apps.js";
const TOKEN = "test-access-token";
const RESOURCE_ID = "/subscriptions/PLACEHOLDER_SUBSCRIPTION_ID/resourceGroups/rg-published-apps/providers/Microsoft.Web/staticSites/my-app";
describe("createStaticWebApp", () => {
    beforeEach(() => installMockFetch());
    afterEach(() => restoreFetch());
    it("PUTs to ARM staticSites endpoint with location and sku", async () => {
        mockFetch((url, init) => {
            if (url.includes("/staticSites/my-app") && init?.method === "PUT") {
                return {
                    status: 200,
                    body: { id: RESOURCE_ID, name: "my-app", location: "westeurope" },
                };
            }
            return undefined;
        });
        const result = await createStaticWebApp(TOKEN, "my-app", {
            appName: "My App",
            appDescription: "A test app",
        });
        assert.equal(result.name, "my-app");
        const calls = getFetchCalls();
        assert.equal(calls.length, 1);
        assert.ok(calls[0].url.includes("/staticSites/my-app"));
        assert.ok(calls[0].url.includes("api-version="));
        assert.equal(calls[0].init?.method, "PUT");
        const body = JSON.parse(calls[0].init?.body);
        assert.equal(body.location, "westeurope");
        assert.equal(body.sku.name, "Standard");
        assert.equal(body.sku.tier, "Standard");
        assert.equal(body.tags.appName, "My App");
        assert.equal(body.tags.appDescription, "A test app");
    });
});
describe("getStaticWebApp", () => {
    beforeEach(() => installMockFetch());
    afterEach(() => restoreFetch());
    it("GETs the staticSites resource by slug", async () => {
        mockFetch((url, init) => {
            if (url.includes("/staticSites/my-app") && (!init?.method || init.method === "GET")) {
                return {
                    status: 200,
                    body: {
                        id: RESOURCE_ID,
                        name: "my-app",
                        properties: { defaultHostname: "my-app.azurestaticapps.net" },
                        tags: { appName: "My App" },
                    },
                };
            }
            return undefined;
        });
        const result = await getStaticWebApp(TOKEN, "my-app");
        assert.equal(result.name, "my-app");
        assert.equal(result.tags.appName, "My App");
        const calls = getFetchCalls();
        assert.equal(calls[0].init?.method, "GET");
    });
});
describe("deleteStaticWebApp", () => {
    beforeEach(() => installMockFetch());
    afterEach(() => restoreFetch());
    it("DELETEs the staticSites resource", async () => {
        mockFetch((url, init) => {
            if (url.includes("/staticSites/my-app") && init?.method === "DELETE") {
                return { status: 204, body: null };
            }
            return undefined;
        });
        await deleteStaticWebApp(TOKEN, "my-app");
        const calls = getFetchCalls();
        assert.equal(calls.length, 1);
        assert.equal(calls[0].init?.method, "DELETE");
        assert.ok(calls[0].url.includes("/staticSites/my-app"));
    });
});
describe("listStaticWebApps", () => {
    beforeEach(() => installMockFetch());
    afterEach(() => restoreFetch());
    it("GETs all staticSites in the resource group", async () => {
        mockFetch((url) => {
            if (url.includes("/staticSites?") || url.includes("/staticSites&")) {
                return {
                    status: 200,
                    body: {
                        value: [
                            { name: "app-one", tags: { appName: "App One" } },
                            { name: "app-two", tags: { appName: "App Two" } },
                        ],
                    },
                };
            }
            return undefined;
        });
        const result = await listStaticWebApps(TOKEN);
        assert.equal(result.length, 2);
        assert.equal(result[0].name, "app-one");
        assert.equal(result[1].name, "app-two");
    });
    it("returns empty array when no apps exist", async () => {
        mockFetch(() => ({
            status: 200,
            body: { value: [] },
        }));
        const result = await listStaticWebApps(TOKEN);
        assert.deepEqual(result, []);
    });
});
describe("getDeploymentToken", () => {
    beforeEach(() => installMockFetch());
    afterEach(() => restoreFetch());
    it("POSTs to listSecrets and returns deployment token", async () => {
        mockFetch((url, init) => {
            if (url.includes("/listSecrets") && init?.method === "POST") {
                return {
                    status: 200,
                    body: { properties: { apiKey: "deploy-token-123" } },
                };
            }
            return undefined;
        });
        const token = await getDeploymentToken(TOKEN, "my-app");
        assert.equal(token, "deploy-token-123");
        const calls = getFetchCalls();
        assert.equal(calls[0].init?.method, "POST");
        assert.ok(calls[0].url.includes("/staticSites/my-app/listSecrets"));
    });
});
describe("updateTags", () => {
    beforeEach(() => installMockFetch());
    afterEach(() => restoreFetch());
    it("PATCHes tags on the resource", async () => {
        mockFetch((url, init) => {
            if (url.includes("/staticSites/my-app") && init?.method === "PATCH") {
                return {
                    status: 200,
                    body: { name: "my-app", tags: { appName: "New Name" } },
                };
            }
            return undefined;
        });
        const result = await updateTags(TOKEN, "my-app", {
            appName: "New Name",
            appDescription: "New desc",
        });
        assert.equal(result.tags.appName, "New Name");
        const calls = getFetchCalls();
        const body = JSON.parse(calls[0].init?.body);
        assert.deepEqual(body.tags, { appName: "New Name", appDescription: "New desc" });
    });
});
describe("deploySwaDir", () => {
    beforeEach(() => installMockFetch());
    afterEach(() => restoreFetch());
    it("gets deployment token via listSecrets", async () => {
        // Mock listSecrets
        mockFetch((url, init) => {
            if (url.includes("/listSecrets") && init?.method === "POST") {
                return { status: 200, body: { properties: { apiKey: "deploy-key-abc" } } };
            }
            return undefined;
        });
        // deploySwaDir calls deploySwaContent which shells out to a binary.
        // We only test the fetch part here (getDeploymentToken).
        // The binary execution is tested at the integration level.
        await assert.rejects(() => deploySwaDir(TOKEN, "my-app", "/tmp/test-output"));
        const calls = getFetchCalls();
        const secretsCall = calls.find((c) => c.url.includes("/listSecrets"));
        assert.ok(secretsCall, "Should call listSecrets to get deployment token");
    });
});
//# sourceMappingURL=static-web-apps.test.js.map