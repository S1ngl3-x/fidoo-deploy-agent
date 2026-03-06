import { stat } from "node:fs/promises";
import type { ToolDefinition, ToolHandler } from "./index.js";
import { loadTokens, isTokenExpired } from "../auth/token-store.js";
import { extractDisplayName } from "../auth/jwt.js";
import { config } from "../config.js";
import { readDeployConfig, writeDeployConfig, generateSlug } from "../deploy/deploy-json.js";
import { loadRegistry, saveRegistry, upsertApp } from "../deploy/registry.js";
import { uploadBlob, generateBlobSasUrl, deleteBlob, createBlobContainer } from "../azure/blob.js";
import { createTarball } from "../deploy/tarball.js";
import { scheduleAcrBuild, pollAcrBuild } from "../azure/acr.js";
import { createOrUpdateContainerApp } from "../azure/container-apps.js";

export const definition: ToolDefinition = {
  name: "container_deploy",
  description:
    "Deploy or re-deploy a fullstack container app to Azure Container Apps. Builds the Docker image via ACR Tasks (no Docker needed locally). Use persistent_storage: true when the app uses SQLite — provisions a blob container and injects Litestream env vars.",
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
        description:
          "Set true when the app uses SQLite. Provisions a dedicated blob container and injects AZURE_STORAGE_* env vars for Litestream. Enforces maxReplicas=1.",
      },
    },
    required: ["folder"],
  },
};

export const handler: ToolHandler = async (args) => {
  const folder = args.folder as string;

  // Validate folder
  try {
    const s = await stat(folder);
    if (!s.isDirectory()) {
      return { content: [{ type: "text", text: `Not a directory: ${folder}` }], isError: true };
    }
  } catch {
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
      const appName = args.app_name as string | undefined;
      const appDescription = args.app_description as string | undefined;
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
        persistentStorage: (args.persistent_storage as boolean | undefined) ?? false,
      };
    }

    const slug = deployConfig!.appSlug;
    const imageRepo = deployConfig!.imageRepository!;
    const persistStorage = deployConfig!.persistentStorage ?? false;
    const port = (args.port as number | undefined) ?? config.defaultPort;

    // 1. Package source as tar.gz and upload to blob
    const tarball = await createTarball(folder);
    const tarPath = `container-builds/${slug}/source-${timestamp}.tar.gz`;
    await uploadBlob(storageToken, tarPath, tarball);

    // 2. Generate SAS URL for ACR Tasks to download the source
    const sasUrl = await generateBlobSasUrl(storageToken, tarPath);

    // 3. Trigger ACR Tasks build and wait for completion
    const runId = await scheduleAcrBuild(armToken, `${slug}:${timestamp}`, sasUrl);
    await pollAcrBuild(armToken, runId, (line) => process.stderr.write(line + "\n"));

    // 4. Provision per-app blob container for Litestream (persistent only)
    const storageContainer = `${slug}-data`;
    if (persistStorage) {
      await createBlobContainer(storageToken, storageContainer);
    }

    // 5. Get storage account key for injecting into Container App secret
    let storageAccountKey = "";
    if (persistStorage) {
      const keyUrl = `https://management.azure.com/subscriptions/${config.subscriptionId}/resourceGroups/${config.resourceGroup}/providers/Microsoft.Storage/storageAccounts/${config.storageAccount}/listKeys?api-version=2023-01-01`;
      const keyRes = await fetch(keyUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${armToken}`, "Content-Type": "application/json" },
      });
      if (!keyRes.ok) {
        throw new Error(`Failed to get storage key: ${keyRes.status} ${await keyRes.text()}`);
      }
      const keyData = (await keyRes.json()) as { keys: { value: string }[] };
      storageAccountKey = keyData.keys[0].value;
    }

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
    deployConfig!.resourceId = containerAppId;
    deployConfig!.containerAppId = containerAppId;
    await writeDeployConfig(folder, deployConfig!);

    // 8. Update registry
    let registry = await loadRegistry(storageToken);
    registry = upsertApp(registry, {
      slug,
      type: "container",
      name: deployConfig!.appName,
      description: deployConfig!.appDescription,
      url: appUrl,
      deployedAt: new Date().toISOString(),
      deployedBy: extractDisplayName(armToken) || "unknown",
      containerAppId,
      imageRepository: imageRepo,
      persistentStorage: persistStorage,
    });
    await saveRegistry(storageToken, registry);

    // 9. Clean up source tarball (fire and forget)
    deleteBlob(storageToken, tarPath).catch(() => {});

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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Deploy failed: ${message}` }],
      isError: true,
    };
  }
};
