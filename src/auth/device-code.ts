/**
 * OAuth2 Device Code Flow for Azure Entra ID.
 * No dependencies — uses global fetch.
 */

import { config } from "../config.js";
import { loadTokens, saveTokens } from "./token-store.js";

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
  message: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

interface ErrorBody {
  error: string;
  error_description?: string;
}

function tokenUrl(tenantId: string): string {
  return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
}

function deviceCodeUrl(tenantId: string): string {
  return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/devicecode`;
}

function encodeForm(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

export async function startDeviceCodeFlow(
  tenantId: string,
  clientId: string,
  scope: string,
): Promise<DeviceCodeResponse> {
  const response = await fetch(deviceCodeUrl(tenantId), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: encodeForm({ client_id: clientId, scope }),
  });

  const body = await response.json() as DeviceCodeResponse | ErrorBody;

  if (!response.ok) {
    const err = body as ErrorBody;
    throw new Error(
      `Device code request failed: ${err.error}${err.error_description ? ` — ${err.error_description}` : ""}`,
    );
  }

  return body as DeviceCodeResponse;
}

export async function pollForToken(
  tenantId: string,
  clientId: string,
  deviceCode: string,
  interval: number,
): Promise<TokenResponse> {
  let currentInterval = interval;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const response = await fetch(tokenUrl(tenantId), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: encodeForm({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: clientId,
        device_code: deviceCode,
      }),
    });

    const body = await response.json() as TokenResponse | ErrorBody;

    if (response.ok) {
      return body as TokenResponse;
    }

    const err = body as ErrorBody;

    if (err.error === "authorization_pending") {
      await sleep(currentInterval);
      continue;
    }

    if (err.error === "slow_down") {
      currentInterval += 5;
      await sleep(currentInterval);
      continue;
    }

    if (err.error === "expired_token") {
      throw new Error("Device code expired. Please restart the login flow.");
    }

    // Any other error is unrecoverable
    throw new Error(
      `Token request failed: ${err.error}${err.error_description ? ` — ${err.error_description}` : ""}`,
    );
  }
}

export async function refreshAccessToken(
  tenantId: string,
  clientId: string,
  refreshToken: string,
  scope?: string,
): Promise<TokenResponse> {
  const params: Record<string, string> = {
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
  };
  if (scope) params.scope = scope;

  const response = await fetch(tokenUrl(tenantId), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: encodeForm(params),
  });

  const body = await response.json() as TokenResponse | ErrorBody;

  if (!response.ok) {
    const err = body as ErrorBody;
    throw new Error(
      `Token refresh failed: ${err.error}${err.error_description ? ` — ${err.error_description}` : ""}`,
    );
  }

  return body as TokenResponse;
}

export async function refreshVaultToken(refreshToken: string): Promise<string> {
  const response = await refreshAccessToken(
    config.tenantId,
    config.clientId,
    refreshToken,
    config.vaultScope,
  );

  // Load-merge-save: preserve existing ARM/Storage tokens, update only vault fields
  const existing = await loadTokens();
  if (existing) {
    await saveTokens({
      ...existing,
      vault_access_token: response.access_token,
      vault_expires_at: Date.now() + response.expires_in * 1000,
      refresh_token: response.refresh_token ?? existing.refresh_token,
    });
  }

  return response.access_token;
}
