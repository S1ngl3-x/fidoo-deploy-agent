import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installMockFetch, restoreFetch, getFetchCalls, mockFetchOnce, } from "../helpers/mock-fetch.js";
import { acquireGraphToken } from "../../src/auth/graph-token.js";
describe("acquireGraphToken", () => {
    beforeEach(() => installMockFetch());
    afterEach(() => restoreFetch());
    it("POSTs to the correct tenant token endpoint", async () => {
        mockFetchOnce({ status: 200, body: { access_token: "graph-token-xyz" } });
        await acquireGraphToken();
        const [call] = getFetchCalls();
        assert.ok(call.url.includes("login.microsoftonline.com"), "must hit Entra ID");
        assert.ok(call.url.includes("oauth2/v2.0/token"), "must use v2.0 token endpoint");
        assert.equal(call.init.method, "POST");
    });
    it("sends client_credentials grant with Graph scope", async () => {
        mockFetchOnce({ status: 200, body: { access_token: "tok" } });
        await acquireGraphToken();
        const [call] = getFetchCalls();
        const body = call.init.body;
        assert.ok(body.includes("grant_type=client_credentials"), "must use client_credentials grant");
        assert.ok(body.includes(encodeURIComponent("https://graph.microsoft.com/.default")), "must request Graph scope");
    });
    it("returns the access_token string from response", async () => {
        mockFetchOnce({ status: 200, body: { access_token: "returned-token" } });
        const token = await acquireGraphToken();
        assert.equal(token, "returned-token");
    });
    it("throws on non-200 response", async () => {
        mockFetchOnce({ status: 400, body: { error: "invalid_client" } });
        await assert.rejects(acquireGraphToken(), /Graph token/);
    });
});
//# sourceMappingURL=graph-token.test.js.map