/**
 * Token storage with file-based persistence.
 *
 * Production path: ~/.deploy-agent/tokens.json (mode 0600)
 * Tests pass a custom dir to avoid touching real storage.
 *
 * Future: macOS Keychain via `security` CLI as primary store.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface StoredTokens {
  access_token: string;          // ARM-scoped token
  storage_access_token: string;  // Storage-scoped token
  vault_access_token?: string;   // Key Vault-scoped token (optional for backward compat)
  refresh_token: string;
  expires_at: number;            // Unix timestamp ms (ARM token)
  storage_expires_at: number;    // Unix timestamp ms (storage token)
  vault_expires_at?: number;     // Unix timestamp ms (vault token, optional for backward compat)
}

const TOKENS_FILE = "tokens.json";
const SAFETY_MARGIN_MS = 5 * 60 * 1000; // 5 minutes

export function getTokenDir(): string {
  return process.env.DEPLOY_AGENT_TOKEN_DIR || path.join(os.homedir(), ".deploy-agent");
}

function tokensPath(dir: string): string {
  return path.join(dir, TOKENS_FILE);
}

export async function saveTokens(
  tokens: StoredTokens,
  dir: string = getTokenDir(),
): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = tokensPath(dir);
  fs.writeFileSync(filePath, JSON.stringify(tokens, null, 2), {
    mode: 0o600,
  });
}

export async function loadTokens(
  dir: string = getTokenDir(),
): Promise<StoredTokens | null> {
  const filePath = tokensPath(dir);
  try {
    const data = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(data) as StoredTokens;
  } catch {
    return null;
  }
}

export async function clearTokens(
  dir: string = getTokenDir(),
): Promise<void> {
  const filePath = tokensPath(dir);
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Already gone — that's fine
  }
}

export function isTokenExpired(tokens: StoredTokens): boolean {
  return tokens.expires_at - Date.now() < SAFETY_MARGIN_MS
    || tokens.storage_expires_at - Date.now() < SAFETY_MARGIN_MS;
}
