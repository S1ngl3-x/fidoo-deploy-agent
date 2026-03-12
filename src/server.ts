import { createStdioTransport, type MethodHandler } from "./protocol.js";
import { toolRegistry } from "./tools/index.js";
import { loadTokens } from "./auth/token-store.js";
import { loadSecrets, config } from "./config.js";
import { refreshVaultToken } from "./auth/device-code.js";

const SERVER_INFO = {
  name: "deploy-agent",
  version: "0.1.0",
};

export async function handleInitialize(
  params: Record<string, unknown> | undefined
) {
  return {
    protocolVersion: "2025-11-25",
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
  };
}

export async function handleToolsList() {
  const tools = Array.from(toolRegistry.values()).map((t) => t.definition);
  return { tools };
}

const EXEMPT_TOOLS = new Set(["auth_login", "auth_poll", "auth_status"]);

export async function handleToolsCall(
  params: Record<string, unknown> | undefined
) {
  const name = (params as { name: string })?.name;
  const args = ((params as { arguments?: Record<string, unknown> })?.arguments) ?? {};

  const tool = toolRegistry.get(name);
  if (!tool) {
    return {
      content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  // Load secrets from Key Vault before dispatching (skip auth tools)
  if (!EXEMPT_TOOLS.has(name) && config.keyVaultName) {
    const tokens = await loadTokens();
    if (tokens) {
      let vaultToken = tokens.vault_access_token;

      // Refresh vault token if missing or expired
      if (!vaultToken || (tokens.vault_expires_at ?? 0) < Date.now()) {
        try {
          vaultToken = await refreshVaultToken(tokens.refresh_token);
        } catch {
          // Vault token refresh failed — proceed without secrets.
          // Tools that need secrets will fail with clear errors downstream.
        }
      }

      if (vaultToken) {
        await loadSecrets(vaultToken);
      }
    }
  }

  return tool.handler(args);
}

// Only start the transport when run as a script (not imported for tests)
const isMainModule =
  process.argv[1] &&
  (process.argv[1].endsWith("/server.js") ||
    process.argv[1].endsWith("\\server.js"));

if (isMainModule) {
  const handlers = new Map<string, MethodHandler>();
  handlers.set("initialize", handleInitialize);
  handlers.set("tools/list", handleToolsList);
  handlers.set("tools/call", handleToolsCall);

  const notificationHandlers = new Map<string, MethodHandler>();
  notificationHandlers.set("notifications/initialized", async () => {});

  createStdioTransport(handlers, notificationHandlers);
}
