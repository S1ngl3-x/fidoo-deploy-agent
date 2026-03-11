import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleInitialize, handleToolsList, handleToolsCall, } from "../src/server.js";
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
//# sourceMappingURL=server.test.js.map