import { stat } from "node:fs/promises";
import { loadTokens, isTokenExpired } from "../auth/token-store.js";
import { extractDisplayName } from "../auth/jwt.js";
import { config } from "../config.js";
import { readDeployConfig, writeDeployConfig, generateSlug } from "../deploy/deploy-json.js";
import { loadRegistry, saveRegistry, upsertApp } from "../deploy/registry.js";
import { createBlobContainer } from "../azure/blob.js";
import { acrBuildFromDir } from "../azure/acr.js";
import { createOrUpdateContainerApp } from "../azure/container-apps.js";
export const definition = {
    name: "container_deploy",
    description: "Deploy or re-deploy a fullstack container app to Azure Container Apps. Builds the Docker image via ACR Tasks (no Docker needed locally). Use persistent_storage: true when the app uses SQLite — provisions a blob container and injects Litestream env vars.",
    inputSchema: {
        type: "object",
        properties: {
            folder: {
                type: "string",
                description: "Absolute path to the app folder containing a Dockerfile",
            },
            app_name: {
                type: "string",
                description: "Display name for the app (first deploy only)",
            },
            app_description: {
                type: "string",
                description: "Short description for the dashboard (first deploy only)",
            },
            port: {
                type: "number",
                description: "Port the container listens on (first deploy only, default 8080)",
            },
            persistent_storage: {
                type: "boolean",
                description: "Set true when the app uses SQLite. Provisions a dedicated blob container and injects AZURE_STORAGE_* env vars for Litestream. Enforces maxReplicas=1.",
            },
        },
        required: ["folder"],
    },
};
export const handler = async (args) => {
    const folder = args.folder;
    // Validate folder
    try {
        const s = await stat(folder);
        if (!s.isDirectory()) {
            return { content: [{ type: "text", text: `Not a directory: ${folder}` }], isError: true };
        }
    }
    catch {
        return { content: [{ type: "text", text: `Folder not found: ${folder}` }], isError: true };
    }
    // Auth
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
    const armToken = tokens.access_token;
    const storageToken = tokens.storage_access_token;
    const timestamp = Date.now();
    try {
        // First deploy or re-deploy?
        let deployConfig = await readDeployConfig(folder);
        const isFirstDeploy = !deployConfig;
        if (isFirstDeploy) {
            const appName = args.app_name;
            const appDescription = args.app_description;
            if (!appName) {
                return {
                    content: [{ type: "text", text: "First deploy requires app_name argument." }],
                    isError: true,
                };
            }
            if (!appDescription) {
                return {
                    content: [{ type: "text", text: "First deploy requires app_description argument." }],
                    isError: true,
                };
            }
            const slug = generateSlug(appName);
            const registry = await loadRegistry(storageToken);
            if (registry.apps.some((a) => a.slug === slug)) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Slug '${slug}' already exists. Choose a different app_name.`,
                        },
                    ],
                    isError: true,
                };
            }
            deployConfig = {
                appSlug: slug,
                appType: "container",
                appName,
                appDescription,
                resourceId: "",
                containerAppId: "",
                imageRepository: `${config.acrLoginServer}/${slug}`,
                persistentStorage: args.persistent_storage ?? false,
            };
        }
        const slug = deployConfig.appSlug;
        const imageRepo = deployConfig.imageRepository;
        const persistStorage = deployConfig.persistentStorage ?? false;
        const port = args.port ?? config.defaultPort;
        // 1-3. Build and push image via az acr build (handles upload + build internally)
        await acrBuildFromDir(folder, `${slug}:${timestamp}`);
        // 4. Provision per-app blob container for Litestream (persistent only)
        const storageContainer = `${slug}-data`;
        if (persistStorage) {
            await createBlobContainer(storageToken, storageContainer);
        }
        // 5. Get storage account key for injecting into Container App secret
        const storageAccountKey = persistStorage ? config.storageKey : "";
        // 6. Create or update Container App
        const appUrl = await createOrUpdateContainerApp(armToken, {
            slug,
            image: `${imageRepo}:${timestamp}`,
            port,
            persistentStorage: persistStorage,
            storageAccountName: config.storageAccount,
            storageAccountKey,
            storageContainer,
        });
        const containerAppId = `/subscriptions/${config.subscriptionId}/resourceGroups/${config.resourceGroup}/providers/Microsoft.App/containerApps/${slug}`;
        // 7. Persist deploy config
        deployConfig.resourceId = containerAppId;
        deployConfig.containerAppId = containerAppId;
        await writeDeployConfig(folder, deployConfig);
        // 8. Update registry
        let registry = await loadRegistry(storageToken);
        registry = upsertApp(registry, {
            slug,
            type: "container",
            name: deployConfig.appName,
            description: deployConfig.appDescription,
            url: appUrl,
            deployedAt: new Date().toISOString(),
            deployedBy: extractDisplayName(armToken) || "unknown",
            containerAppId,
            imageRepository: imageRepo,
            persistentStorage: persistStorage,
        });
        await saveRegistry(storageToken, registry);
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        status: "ok",
                        url: appUrl,
                        slug,
                        persistentStorage: persistStorage,
                        message: isFirstDeploy ? `Deployed! ${appUrl}` : `Updated! ${appUrl}`,
                    }),
                },
            ],
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            content: [{ type: "text", text: `Deploy failed: ${message}` }],
            isError: true,
        };
    }
};
//# sourceMappingURL=container-deploy.js.map