# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Test Commands

```bash
npm run build          # Compile TypeScript to dist/
npm run dev            # Watch mode (tsc --watch)
npm test               # Run all tests (uses --test-force-exit, may skip slow tests)
node --test dist/test/*.test.js dist/test/**/*.test.js   # Full test suite including integration (no force-exit, preferred for verification)
node --test dist/test/tools/app-list.test.js             # Run a single test file
node --test dist/test/integration/*.test.js              # Integration tests only (end-to-end MCP + deploy flow)
```

Always `npm run build` before running tests — tests run from `dist/`.

## Architecture

MCP server plugin for Claude Code that deploys apps to Azure. Two deployment modes: **static apps** (HTML/JS → Azure Static Web App with path-based routing at `https://{domain}/{slug}/`) and **container apps** (Dockerfile → Azure Container Apps at `https://{slug}.{containerDomain}`). App content is stored in Azure Blob Storage; a single SWA hosts the assembled static site (all apps + dashboard).

**Protocol:** JSON-RPC 2.0 over stdio. `src/protocol.ts` handles message framing, `src/server.ts` routes `initialize`, `tools/list`, and `tools/call` methods.

**Tool pattern:** Each tool in `src/tools/` exports `definition: ToolDefinition` (name, description, inputSchema) and `handler: ToolHandler` (async function returning `{ content: [{type: "text", text: string}], isError?: boolean }`). All 10 tools are registered in `src/tools/index.ts`: `auth_login`, `auth_poll`, `auth_status`, `app_deploy`, `app_delete`, `app_list`, `app_info`, `app_update_info`, `container_deploy`, `container_delete`.

**Auth flow:** OAuth2 device code flow via `src/auth/device-code.ts`. Three scoped tokens from a single refresh token: `access_token` (ARM scope, for SWA/Container Apps management), `storage_access_token` (Storage scope, for blob operations), and `vault_access_token` (Key Vault scope, for secret resolution). All tracked independently with `expires_at` / `storage_expires_at` / `vault_expires_at`. Cached to `~/.deploy-agent/tokens.json` (mode 0600). Vault token is best-effort — auth succeeds even if vault token exchange fails (ARM + Storage tokens are always saved). `src/auth/jwt.ts` decodes the ARM token without verification to extract display name for audit tagging. Override dir with `DEPLOY_AGENT_TOKEN_DIR` env var (used in tests).

**Key Vault secret resolution:** When `DEPLOY_AGENT_KEY_VAULT_NAME` is set, `src/config.ts:loadSecrets()` fetches 4 secrets in parallel from Azure Key Vault at runtime: `deploy-storage-key`, `deploy-acr-admin-password`, `deploy-portal-client-secret`, `deploy-graph-sp-client-secret`. Called by `src/server.ts` before every non-exempt tool dispatch. Auth tools (`auth_login`, `auth_poll`, `auth_status`) are exempt. Env var overrides win — secrets already set via env vars are not fetched from vault. Idempotent — only runs once per server lifetime. `src/auth/keyvault.ts:fetchSecret()` calls Key Vault REST API v7.4 with a vault-scoped Bearer token. `src/auth/device-code.ts:refreshVaultToken()` handles vault token lifecycle (load-merge-save to preserve ARM/Storage tokens).

**Azure layer:** `src/azure/rest-client.ts` wraps `fetch` with ARM base URL, Bearer header, and api-version. Throws `AzureError` with `.status` and `.code` on non-2xx. `src/azure/static-web-apps.ts` manages SWA deployment. `src/azure/blob.ts` handles blob upload/download/delete using Shared Key auth (HMAC-SHA256) when `storageKey` is available, falling back to Bearer token auth. `src/azure/container-apps.ts` manages Container App CRUD, ACR image builds, and Easy Auth configuration. `src/azure/acr.ts` handles ACR REST API for image builds via ACR Tasks.

**Static deploy flow:** `collectFiles` (deny-list: `.git/`, `node_modules/`, `.deploy.json`, `.env*`, certs, SSH keys) → blob upload (`src/azure/blob.ts`) → registry update (`src/deploy/registry.ts`) → `assembleSite` (`src/deploy/assemble.ts`: downloads all apps from blob, generates dashboard HTML + `staticwebapp.config.json` + `/login` redirect page) → deploy assembled dir to SWA via StaticSitesClient binary (`src/deploy/swa-client.ts` — auto-downloaded and cached in `~/.swa/deploy/`).

**Container deploy flow:** Upload source as tarball to ACR → build image via ACR Tasks → create/update Container App via ARM PUT → poll provisioning until Succeeded → configure Easy Auth (Entra ID via Deploy Portal app) → add redirect URI via Graph API → update registry → redeploy SWA site (dashboard update).

**First deploy vs re-deploy:** `app_deploy` / `container_deploy` checks for `.deploy.json` in the target folder. If absent, it's a first deploy (requires `app_name` + `app_description`, generates a slug, writes `.deploy.json`). If present, it re-deploys using the stored slug. `.deploy.json` contains `{ appSlug, appType, appName, appDescription, resourceId, ... }` and should be committed to the app's repo.

**SWA end-user auth:** The assembled site's `staticwebapp.config.json` enforces Entra ID login for all routes using a separate "Deploy Portal" AAD app registration (`PORTAL_CLIENT_ID` / `PORTAL_CLIENT_SECRET` SWA app settings — set by `setup.sh`, not the deploy agent). The `/login` page (`src/deploy/login.ts`) captures the pre-auth referrer URL for post-login redirect back to the originally requested path.

**Container Easy Auth:** Each container app gets Entra ID auth via ARM `authSettingsV2`, reusing the Deploy Portal AAD app registration. A dedicated "Deploy Agent Graph SP" (with `Application.ReadWrite.OwnedBy`) manages redirect URIs on the Deploy Portal app. The Graph SP is owner of the Deploy Portal app so it can PATCH redirect URIs.

**Plugin manifest:** `.claude-plugin/plugin.json` registers this as a Claude Code MCP plugin. Skills live in `skills/`.

**Registry:** `registry.json` in Azure Blob Storage is the source of truth for app metadata (slug, title, description, version, type). Updated on every deploy/delete/update-info. Entries have `type: "static" | "container"`.

**Dashboard:** Auto-generated HTML listing all deployed apps (both static and container). Built by `src/deploy/dashboard.ts` during site assembly from registry data. No separate dashboard tool — the dashboard is regenerated as part of every site deploy.

## Config Environment Variables

| Variable | Description | Default |
|---|---|---|
| **Core** | | |
| `DEPLOY_AGENT_TENANT_ID` | Azure AD tenant ID | (required) |
| `DEPLOY_AGENT_CLIENT_ID` | Deploy Plugin app registration client ID | (required) |
| `DEPLOY_AGENT_SUBSCRIPTION_ID` | Azure subscription ID | (required) |
| `DEPLOY_AGENT_RESOURCE_GROUP` | Azure resource group name (static apps) | (required) |
| `DEPLOY_AGENT_STORAGE_ACCOUNT` | Azure Storage account name | (required) |
| `DEPLOY_AGENT_STORAGE_KEY` | Storage account key (Shared Key auth for blobs) | (secret — via KV or env) |
| `DEPLOY_AGENT_CONTAINER_NAME` | Blob container name | `app-content` |
| `DEPLOY_AGENT_APP_DOMAIN` | Custom domain for static apps | `ai-apps.env.fidoo.cloud` |
| `DEPLOY_AGENT_SWA_SLUG` | Single SWA resource name | `swa-ai-apps` |
| `DEPLOY_AGENT_LOCATION` | Azure region | `westeurope` |
| `DEPLOY_AGENT_TOKEN_DIR` | Override token storage dir | `~/.deploy-agent` |
| **Container Apps** | | |
| `DEPLOY_AGENT_CONTAINER_RESOURCE_GROUP` | Resource group for container apps | falls back to `DEPLOY_AGENT_RESOURCE_GROUP` |
| `DEPLOY_AGENT_ACR_NAME` | Azure Container Registry name | (required for containers) |
| `DEPLOY_AGENT_ACR_LOGIN_SERVER` | ACR login server FQDN | (required for containers) |
| `DEPLOY_AGENT_ACR_ADMIN_USERNAME` | ACR admin username | (required for containers) |
| `DEPLOY_AGENT_ACR_ADMIN_PASSWORD` | ACR admin password | (secret — via KV or env) |
| `DEPLOY_AGENT_CONTAINER_ENV_NAME` | Container Apps Environment name | (required for containers) |
| `DEPLOY_AGENT_CONTAINER_DOMAIN` | Custom domain for container apps | `api.env.fidoo.cloud` |
| `DEPLOY_AGENT_PULL_IDENTITY_ID` | Managed identity resource ID for ACR pull | (optional — falls back to ACR admin) |
| `DEPLOY_AGENT_DEFAULT_PORT` | Default container port | `8080` |
| **Easy Auth** | | |
| `DEPLOY_AGENT_PORTAL_CLIENT_ID` | Deploy Portal AAD app client ID | (required for Easy Auth) |
| `DEPLOY_AGENT_PORTAL_CLIENT_SECRET` | Deploy Portal AAD app client secret | (secret — via KV or env) |
| `DEPLOY_AGENT_PORTAL_OBJECT_ID` | Deploy Portal AAD app object ID (for Graph PATCH) | (required for Easy Auth) |
| `DEPLOY_AGENT_GRAPH_SP_CLIENT_ID` | Graph SP client ID (redirect URI management) | (required for Easy Auth) |
| `DEPLOY_AGENT_GRAPH_SP_CLIENT_SECRET` | Graph SP client secret | (secret — via KV or env) |
| **Key Vault** | | |
| `DEPLOY_AGENT_KEY_VAULT_NAME` | Azure Key Vault name (enables runtime secret resolution) | (optional) |

## Key Conventions

- **Zero runtime deps.** Only `typescript` and `@types/node` as devDeps. ZIP format, JSON-RPC, and OAuth are all hand-rolled.
- **ESM only.** `"type": "module"` in package.json, `NodeNext` module resolution. All imports use `.js` extensions.
- **Node.js 22+ required.** Uses `zlib.crc32`.
- **rootDir is `.`** (not `./src`), so compiled output mirrors source: `dist/src/`, `dist/test/`.
- **Test runner:** `node:test` + `node:assert/strict`. No test framework.
- **Test mocking:** Two mock helpers — `test/helpers/mock-fetch.ts` (`installMockFetch`/`restoreFetch`/`mockFetch`/`getFetchCalls`) for intercepting global `fetch`, and `test/helpers/mock-swa-deploy.ts` (`listSecretsMatcher`/`mockExecFile`) for SWA binary deployment. Tool tests use temp dirs for token storage via `DEPLOY_AGENT_TOKEN_DIR`. SWA mock requires `mock.restoreAll()` in `afterEach`.
- **TDD workflow.** Write tests first, verify they fail, then implement.
