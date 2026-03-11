import { createStdioTransport, type MethodHandler } from "./protocol.js";
import { toolRegistry } from "./tools/index.js";

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

  return tool.handler(args);
}

// Only start the transport when run as a script (not imported for tests)
const isMainModule =
  process.argv[1] &&
  (process.argv[1].endsWith("/server.js") ||
    process.argv[1].endsWith("\\server.js") ||
    process.argv[1].endsWith("/server.ts") ||
    process.argv[1].endsWith("\\server.ts"));

if (isMainModule) {
  const handlers = new Map<string, MethodHandler>();
  handlers.set("initialize", handleInitialize);
  handlers.set("tools/list", handleToolsList);
  handlers.set("tools/call", handleToolsCall);

  const notificationHandlers = new Map<string, MethodHandler>();
  notificationHandlers.set("notifications/initialized", async () => {});

  createStdioTransport(handlers, notificationHandlers);
}
