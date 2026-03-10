import { loadTokens, isTokenExpired } from "../auth/token-store.js";
import { config } from "../config.js";
import { loadRegistry } from "../deploy/registry.js";
export const definition = {
    name: "app_info",
    description: "Get details for a deployed app: URL, status, name, description, and last deploy time.",
    inputSchema: {
        type: "object",
        properties: {
            app_slug: {
                type: "string",
                description: "The slug (URL name) of the app",
            },
        },
        required: ["app_slug"],
    },
};
export const handler = async (args) => {
    const appSlug = args.app_slug;
    if (!appSlug) {
        return {
            content: [{ type: "text", text: "Missing required argument: app_slug" }],
            isError: true,
        };
    }
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
        const app = registry.apps.find((a) => a.slug === appSlug);
        if (!app) {
            return {
                content: [{ type: "text", text: `App "${appSlug}" not found.` }],
                isError: true,
            };
        }
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        slug: app.slug,
                        name: app.name,
                        description: app.description,
                        url: app.type === "container" ? (app.url ?? "") : `https://${config.appDomain}/${app.slug}/`,
                        deployedAt: app.deployedAt,
                        deployedBy: app.deployedBy,
                        type: app.type ?? "static",
                        ...(app.type === "container" && {
                            containerAppId: app.containerAppId,
                            imageRepository: app.imageRepository,
                            persistentStorage: app.persistentStorage ?? false,
                        }),
                    }),
                },
            ],
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            content: [{ type: "text", text: `Failed to get app info: ${message}` }],
            isError: true,
        };
    }
};
//# sourceMappingURL=app-info.js.map