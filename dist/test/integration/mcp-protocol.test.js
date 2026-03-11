/**
 * Integration test: MCP protocol flow via stdio.
 *
 * Spawns the server as a child process, sends JSON-RPC messages over stdin,
 * and verifies responses on stdout.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const SERVER_PATH = join(import.meta.dirname, "../../src/server.js");
let tokenDir;
function startServer(env) {
    const child = spawn("node", [SERVER_PATH], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...env },
    });
    let buffer = "";
    const responseQueue = [];
    const waiters = [];
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            const parsed = JSON.parse(trimmed);
            const waiter = waiters.shift();
            if (waiter) {
                waiter(parsed);
            }
            else {
                responseQueue.push(parsed);
            }
        }
    });
    return {
        send(msg) {
            child.stdin.write(JSON.stringify(msg) + "\n");
        },
        receive() {
            const queued = responseQueue.shift();
            if (queued)
                return Promise.resolve(queued);
            return new Promise((resolve) => {
                waiters.push(resolve);
            });
        },
        close() {
            child.stdin.end();
            child.kill();
        },
    };
}
describe("integration: MCP protocol over stdio", () => {
    beforeEach(async () => {
        tokenDir = await mkdtemp(join(tmpdir(), "mcp-token-"));
    });
    afterEach(async () => {
        await rm(tokenDir, { recursive: true, force: true });
    });
    it("handles initialize → notifications/initialized → tools/list → tools/call sequence", async () => {
        const server = startServer({ DEPLOY_AGENT_TOKEN_DIR: tokenDir });
        try {
            // ---- Initialize ----
            server.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
            const initResp = await server.receive();
            assert.equal(initResp.jsonrpc, "2.0");
            assert.equal(initResp.id, 1);
            assert.ok(initResp.result, "initialize should return result");
            const initResult = initResp.result;
            assert.equal(initResult.protocolVersion, "2025-11-25");
            assert.equal(initResult.serverInfo.name, "deploy-agent");
            assert.ok(initResult.capabilities);
            // ---- Send notification (no response expected) ----
            server.send({ jsonrpc: "2.0", method: "notifications/initialized" });
            // ---- tools/list ----
            server.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
            const listResp = await server.receive();
            assert.equal(listResp.id, 2);
            assert.ok(listResp.result, "tools/list should return result");
            const tools = listResp.result.tools;
            assert.ok(Array.isArray(tools));
            assert.ok(tools.length === 10, `Expected 10 tools, got ${tools.length}`);
            const toolNames = tools.map((t) => t.name).sort();
            assert.deepEqual(toolNames, [
                "app_delete",
                "app_deploy",
                "app_info",
                "app_list",
                "app_update_info",
                "auth_login",
                "auth_poll",
                "auth_status",
                "container_delete",
                "container_deploy",
            ]);
            // ---- tools/call — auth_status (no tokens = not authenticated) ----
            server.send({
                jsonrpc: "2.0",
                id: 3,
                method: "tools/call",
                params: { name: "auth_status", arguments: {} },
            });
            const statusResp = await server.receive();
            assert.equal(statusResp.id, 3);
            const statusResult = statusResp.result;
            const statusData = JSON.parse(statusResult.content[0].text);
            assert.equal(statusData.status, "not_authenticated");
            // ---- tools/call — unknown tool ----
            server.send({
                jsonrpc: "2.0",
                id: 4,
                method: "tools/call",
                params: { name: "nonexistent_tool", arguments: {} },
            });
            const unknownResp = await server.receive();
            assert.equal(unknownResp.id, 4);
            const unknownResult = unknownResp.result;
            assert.ok(unknownResult.isError);
            assert.ok(unknownResult.content[0].text.includes("Unknown tool"));
            // ---- Unknown method ----
            server.send({
                jsonrpc: "2.0",
                id: 5,
                method: "unknown/method",
            });
            const errorResp = await server.receive();
            assert.equal(errorResp.id, 5);
            assert.ok(errorResp.error, "Unknown method should return error");
            assert.equal(errorResp.error.code, -32601); // MethodNotFound
            // ---- Invalid JSON ----
            server.send("not-valid-json\n");
            // The send function will JSON.stringify the object, but we need raw text.
            // Let's use the underlying stdin directly for this test.
        }
        finally {
            server.close();
        }
    });
    it("returns parse error for invalid JSON", async () => {
        const child = spawn("node", [SERVER_PATH], {
            stdio: ["pipe", "pipe", "pipe"],
        });
        try {
            const response = await new Promise((resolve) => {
                let buf = "";
                child.stdout.setEncoding("utf-8");
                child.stdout.on("data", (chunk) => {
                    buf += chunk;
                    const lines = buf.split("\n");
                    buf = lines.pop();
                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (trimmed)
                            resolve(JSON.parse(trimmed));
                    }
                });
                // Write invalid JSON directly
                child.stdin.write("{invalid json}\n");
            });
            assert.equal(response.jsonrpc, "2.0");
            assert.ok(response.error, "Should return error for invalid JSON");
            assert.equal(response.error.code, -32700); // ParseError
        }
        finally {
            child.stdin.end();
            child.kill();
        }
    });
});
//# sourceMappingURL=mcp-protocol.test.js.map