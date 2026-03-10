import * as authStatus from "./auth-status.js";
import * as authLogin from "./auth-login.js";
import * as authPoll from "./auth-poll.js";
import * as appDeploy from "./app-deploy.js";
import * as appDelete from "./app-delete.js";
import * as appList from "./app-list.js";
import * as appInfo from "./app-info.js";
import * as appUpdateInfo from "./app-update-info.js";
import * as containerDeploy from "./container-deploy.js";
import * as containerDelete from "./container-delete.js";


export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

export interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

const tools: RegisteredTool[] = [
  authStatus,
  authLogin,
  authPoll,
  appDeploy,
  appDelete,
  appList,
  appInfo,
  appUpdateInfo,
  containerDeploy,
  containerDelete,
];

export const toolRegistry = new Map<string, RegisteredTool>(
  tools.map((t) => [t.definition.name, t])
);
