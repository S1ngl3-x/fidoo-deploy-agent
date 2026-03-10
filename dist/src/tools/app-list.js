import { loadTokens, isTokenExpired } from "../auth/token-store.js";
import { config } from "../config.js";
import { loadRegistry } from "../deploy/registry.js";
export const definition = {
    name: "app_list",
    description: "List all deployed apps with their names, slugs, and URLs.",
    inputSchema: {
        type: "object",
        properties: {},
    },
};
export const handler = async (_args) => {
    const tokens = await loadTokens();
    if (!tokens) {
        return {
            content: [{ type: "text", text: "Not authenticated. Run auth_login first." }],
            isError: true,
        };
    }
    if (isTokenExpired(tokens)) {
        return {
            content: [{ type: "text", text: "Token expired. Run auth_login to re-authenticate." }],
            isError: true,
        };
    }
    try {
        const registry = await loadRegistry(tokens.storage_access_token);
        const apps = registry.apps.map((app) => ({
            slug: app.slug,
            name: app.name,
            description: app.description,
            url: app.type === "container" ? (app.url ?? "") : `https://${config.appDomain}/${app.slug}/`,
            deployedAt: app.deployedAt,
            type: app.type ?? "static",
        }));
        return {
            content: [{ type: "text", text: JSON.stringify({ apps }) }],
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            content: [{ type: "text", text: `Failed to list apps: ${message}` }],
            isError: true,
        };
    }
};
//# sourceMappingURL=app-list.js.map