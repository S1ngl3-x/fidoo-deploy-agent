import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateDashboardHtml } from "../../src/deploy/dashboard.js";
describe("generateDashboardHtml", () => {
    it("returns string containing <!DOCTYPE html>", () => {
        const html = generateDashboardHtml([]);
        assert.ok(html.includes("<!DOCTYPE html>"));
    });
    it("includes strict CSP meta tag", () => {
        const html = generateDashboardHtml([]);
        assert.ok(html.includes("default-src 'self'"));
        assert.ok(html.includes("script-src 'unsafe-inline'"));
    });
    it("embeds apps data in a script tag", () => {
        const apps = [
            {
                slug: "test-app",
                name: "Test App",
                description: "A test",
                deployedAt: "2026-01-01T00:00:00.000Z",
                deployedBy: "user1",
            },
        ];
        const html = generateDashboardHtml(apps);
        assert.ok(html.includes("<script>"));
        assert.ok(html.includes("test-app"));
        assert.ok(html.includes("Test App"));
    });
    it("uses textContent (not innerHTML)", () => {
        const html = generateDashboardHtml([]);
        assert.ok(html.includes("textContent"));
        assert.ok(!html.includes("innerHTML"));
    });
    it("renders with empty apps array", () => {
        const html = generateDashboardHtml([]);
        assert.ok(html.includes("<!DOCTYPE html>"));
        assert.ok(html.includes("[]"));
    });
    it("escapes </script> in app data", () => {
        const apps = [
            {
                slug: "xss-app",
                name: "</script><script>alert(1)</script>",
                description: "test",
                deployedAt: "",
                deployedBy: "attacker",
            },
        ];
        const html = generateDashboardHtml(apps);
        // Should not contain a literal </script> inside the data
        // Split on <script> tags and check the script content
        const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
        assert.ok(scriptMatch, "Should have a script tag");
        // The script content should not contain </script>
        assert.ok(!scriptMatch[1].includes("</script>"), "Script content must not contain literal </script>");
        // But should contain the escaped version
        assert.ok(html.includes("<\\/script>") || html.includes("<\\/"));
    });
    it("generates links with path-based URLs", () => {
        const apps = [
            { slug: "calc", name: "Calculator", description: "A calc", deployedAt: "2026-01-01T00:00:00Z", deployedBy: "u" },
        ];
        const html = generateDashboardHtml(apps);
        // Static apps use path-based URL, container apps use app.url
        assert.ok(html.includes('app.url || ("/" + app.slug + "/")'));
        assert.ok(!html.includes(".env.fidoo.cloud")); // no per-app subdomain in template
    });
});
//# sourceMappingURL=dashboard.test.js.map