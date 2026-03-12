import type { ToolDefinition, ToolHandler } from "./index.js";
import { pollForToken, refreshAccessToken } from "../auth/device-code.js";
import { saveTokens } from "../auth/token-store.js";
import { config } from "../config.js";

export const definition: ToolDefinition = {
  name: "auth_poll",
  description:
    "Poll for token after user completes browser login. Call after auth_login.",
  inputSchema: {
    type: "object",
    properties: {
      device_code: {
        type: "string",
        description: "The device code returned by auth_login",
      },
    },
    required: ["device_code"],
  },
};

export const handler: ToolHandler = async (args) => {
  const deviceCode = args.device_code as string | undefined;

  if (!deviceCode) {
    return {
      content: [
        {
          type: "text",
          text: "Missing required parameter: device_code",
        },
      ],
      isError: true,
    };
  }

  try {
    // Get ARM token from device code flow
    const armTokenResponse = await pollForToken(
      config.tenantId,
      config.clientId,
      deviceCode,
      5, // Default 5-second polling interval per OAuth2 spec
    );

    // Use refresh token to get a storage-scoped token
    const storageTokenResponse = await refreshAccessToken(
      config.tenantId,
      config.clientId,
      armTokenResponse.refresh_token,
      config.storageScope,
    );

    // Use refresh token to get a vault-scoped token (best-effort)
    let vaultAccessToken: string | undefined;
    let vaultExpiresAt: number | undefined;
    let latestRefreshToken = storageTokenResponse.refresh_token;
    let vaultWarning = "";

    try {
      const vaultTokenResponse = await refreshAccessToken(
        config.tenantId,
        config.clientId,
        storageTokenResponse.refresh_token,
        config.vaultScope,
      );
      vaultAccessToken = vaultTokenResponse.access_token;
      vaultExpiresAt = Date.now() + vaultTokenResponse.expires_in * 1000;
      latestRefreshToken = vaultTokenResponse.refresh_token;
    } catch (e) {
      vaultWarning = ` (vault token failed: ${(e as Error).message})`;
    }

    const armExpiresAt = Date.now() + armTokenResponse.expires_in * 1000;
    const storageExpiresAt = Date.now() + storageTokenResponse.expires_in * 1000;

    await saveTokens({
      access_token: armTokenResponse.access_token,
      storage_access_token: storageTokenResponse.access_token,
      vault_access_token: vaultAccessToken,
      refresh_token: latestRefreshToken,
      expires_at: armExpiresAt,
      storage_expires_at: storageExpiresAt,
      vault_expires_at: vaultExpiresAt,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "authenticated",
            expires_at: armExpiresAt,
          }) + vaultWarning,
        },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `Polling failed: ${(err as Error).message}`,
        },
      ],
      isError: true,
    };
  }
};
