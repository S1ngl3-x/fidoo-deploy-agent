import type { ToolDefinition, ToolHandler } from "./index.js";
import { loadTokens, isTokenExpired } from "../auth/token-store.js";
import { loadRegistry, saveRegistry, removeApp } from "../deploy/registry.js";
import { deleteContainerApp } from "../azure/container-apps.js";
import { deleteBlobContainer } from "../azure/blob.js";

export const definition: ToolDefinition = {
  name: "container_delete",
  description:
    "Delete a container app and remove it from the registry. If the app has persistent storage, the data blob container is also deleted (irreversible data loss).",
  inputSchema: {
    type: "object",
    properties: {
      slug: {
        type: "string",
        description: "The slug of the container app to delete",
      },
      confirm_data_deletion: {
        type: "boolean",
        description:
          "Required when the app has persistentStorage=true. Set to true to confirm you accept permanent data loss.",
      },
    },
    required: ["slug"],
  },
};

export const handler: ToolHandler = async (args) => {
  const slug = args.slug as string | undefined;
  if (!slug) {
    return {
      content: [{ type: "text", text: "Missing required argument: slug" }],
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

  const armToken = tokens.access_token;
  const storageToken = tokens.storage_access_token;

  try {
    const registry = await loadRegistry(storageToken);
    const entry = registry.apps.find((a) => a.slug === slug);

    if (!entry) {
      return {
        content: [{ type: "text", text: `App '${slug}' not found in registry.` }],
        isError: true,
      };
    }

    if (entry.persistentStorage && !args.confirm_data_deletion) {
      return {
        content: [
          {
            type: "text",
            text: `⚠️ App '${slug}' has persistent storage. Deleting will permanently destroy all data in blob container '${slug}-data'. Call again with confirm_data_deletion: true to confirm.`,
          },
        ],
        isError: true,
      };
    }

    // Delete Container App
    await deleteContainerApp(armToken, slug);

    // Delete data blob container if persistent
    if (entry.persistentStorage) {
      await deleteBlobContainer(storageToken, `${slug}-data`);
    }

    // Remove from registry
    const updated = removeApp(registry, slug);
    await saveRegistry(storageToken, updated);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "ok",
            message: `Deleted '${slug}'.${entry.persistentStorage ? " Data blob container deleted." : ""}`,
          }),
        },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Delete failed: ${message}` }],
      isError: true,
    };
  }
};
