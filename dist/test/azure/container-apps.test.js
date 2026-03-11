import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installMockFetch, restoreFetch, getFetchCalls, mockFetch, } from "../helpers/mock-fetch.js";
import { addRedirectUri, removeRedirectUri } from "../../src/azure/container-apps.js";
// config.portalObjectId defaults to "" in tests (no env var set).
// Match on the stable prefix, not the dynamic object ID value.
const GRAPH_APPS_PATH = "graph.microsoft.com/v1.0/applications";
describe("addRedirectUri", () => {
    beforeEach(() => installMockFetch());
    afterEach(() => restoreFetch());
    it("GETs existing URIs then PATCHes with new URI appended", async () => {
        const existing = ["https://existing.example.com/.auth/login/aad/callback"];
        mockFetch((url, init) => {
            if (url.includes(GRAPH_APPS_PATH) && (!init?.method || init.method === "GET"))
                return { status: 200, body: { web: { redirectUris: existing } } };
            if (url.includes(GRAPH_APPS_PATH) && init?.method === "PATCH")
                return { status: 200, body: {} };
            return undefined;
        });
        await addRedirectUri("graph-token", "my-app");
        const calls = getFetchCalls();
        const patch = calls.find((c) => c.init?.method === "PATCH");
        assert.ok(patch, "PATCH call expected");
        const body = JSON.parse(patch.init.body);
        assert.ok(body.web.redirectUris.includes("https://my-app.api.env.fidoo.cloud/.auth/login/aad/callback"));
        assert.ok(body.web.redirectUris.includes("https://existing.example.com/.auth/login/aad/callback"));
    });
    it("does not duplicate an existing redirect URI", async () => {
        const uri = "https://my-app.api.env.fidoo.cloud/.auth/login/aad/callback";
        mockFetch((url, init) => {
            if (url.includes(GRAPH_APPS_PATH) && (!init?.method || init.method === "GET"))
                return { status: 200, body: { web: { redirectUris: [uri] } } };
            if (url.includes(GRAPH_APPS_PATH) && init?.method === "PATCH")
                return { status: 200, body: {} };
            return undefined;
        });
        await addRedirectUri("graph-token", "my-app");
        const calls = getFetchCalls();
        // Should NOT have PATCHed since URI already exists
        const patch = calls.find((c) => c.init?.method === "PATCH");
        assert.equal(patch, undefined, "should not PATCH when URI already exists");
    });
    it("uses Bearer token in Authorization header", async () => {
        mockFetch((url, init) => {
            if (url.includes(GRAPH_APPS_PATH) && (!init?.method || init.method === "GET"))
                return { status: 200, body: { web: { redirectUris: [] } } };
            if (url.includes(GRAPH_APPS_PATH) && init?.method === "PATCH")
                return { status: 200, body: {} };
            return undefined;
        });
        await addRedirectUri("my-graph-token", "slug");
        const calls = getFetchCalls();
        for (const call of calls) {
            const auth = call.init?.headers?.["Authorization"];
            assert.ok(auth?.includes("my-graph-token"), "Bearer token must be used");
        }
    });
});
describe("removeRedirectUri", () => {
    beforeEach(() => installMockFetch());
    afterEach(() => restoreFetch());
    it("removes the target URI and PATCHes the remaining list", async () => {
        const target = "https://my-app.api.env.fidoo.cloud/.auth/login/aad/callback";
        const other = "https://other.api.env.fidoo.cloud/.auth/login/aad/callback";
        mockFetch((url, init) => {
            if (url.includes(GRAPH_APPS_PATH) && (!init?.method || init.method === "GET"))
                return { status: 200, body: { web: { redirectUris: [target, other] } } };
            if (url.includes(GRAPH_APPS_PATH) && init?.method === "PATCH")
                return { status: 200, body: {} };
            return undefined;
        });
        await removeRedirectUri("graph-token", "my-app");
        const patch = getFetchCalls().find((c) => c.init?.method === "PATCH");
        assert.ok(patch);
        const body = JSON.parse(patch.init.body);
        assert.ok(!body.web.redirectUris.includes(target), "target URI must be removed");
        assert.ok(body.web.redirectUris.includes(other), "other URIs must remain");
    });
    it("is a no-op when the URI is not in the list", async () => {
        mockFetch((url, init) => {
            if (url.includes(GRAPH_APPS_PATH) && (!init?.method || init.method === "GET"))
                return { status: 200, body: { web: { redirectUris: [] } } };
            if (url.includes(GRAPH_APPS_PATH) && init?.method === "PATCH")
                return { status: 200, body: {} };
            return undefined;
        });
        // Should not throw
        await removeRedirectUri("graph-token", "nonexistent-app");
        // Should not PATCH since URI wasn't in the list
        const patch = getFetchCalls().find((c) => c.init?.method === "PATCH");
        assert.equal(patch, undefined, "should not PATCH when URI not in list");
    });
});
//# sourceMappingURL=container-apps.test.js.map