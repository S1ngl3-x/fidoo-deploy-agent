import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toolRegistry } from "../../src/tools/index.js";
const EXPECTED_TOOLS = [
    "auth_status",
    "auth_login",
    "auth_poll",
    "app_deploy",
    "app_delete",
    "app_list",
    "app_info",
    "app_update_info",
    "container_deploy",
    "container_delete",
];
describe("tool registry", () => {
    it("contains exactly 10 tools", () => {
        assert.equal(toolRegistry.size, 10);
    });
    for (const name of EXPECTED_TOOLS) {
        it(`has tool '${name}' with definition and handler`, () => {
            const tool = toolRegistry.get(name);
            assert.ok(tool, `Tool ${name} not found`);
            assert.equal(tool.definition.name, name);
            assert.equal(typeof tool.definition.description, "string");
            assert.ok(tool.definition.description.length > 0, "Description must not be empty");
            assert.ok(tool.definition.inputSchema, "Must have inputSchema");
            assert.equal(tool.definition.inputSchema.type, "object");
            assert.equal(typeof tool.handler, "function");
        });
    }
});
//# sourceMappingURL=tool-stubs.test.js.map