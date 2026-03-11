# Deploy Agent — Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Publisher (Claude Code + MCP plugin)                                       │
│                                                                             │
│  app_deploy / container_deploy / app_delete                                 │
└────────────────────────────┬────────────────────────────────────────────────┘
                             │ ARM token (device code flow)
                             │ Storage token
                             ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  Azure                                                                       │
│                                                                              │
│  ┌─────────────────────────────┐    ┌──────────────────────────────────────┐ │
│  │  Static App path            │    │  Container App path                  │ │
│  │                             │    │                                      │ │
│  │  Blob Storage               │    │  ACR (fidooapps)                     │ │
│  │  ├─ app-content/            │    │  └─ Build image (ACR Tasks)          │ │
│  │  │   ├─ {slug}.zip          │    │                                      │ │
│  │  │   └─ registry.json       │    │  Container Apps Environment          │ │
│  │  │                          │    │  └─ Container App ({slug})           │ │
│  │  Static Web App (swa-ai-apps│    │      ├─ Easy Auth (Deploy Portal)    │ │
│  │  └─ /{slug}/ (app files)    │    │      ├─ Image pull (managed identity)│ │
│  │  └─ / (dashboard)           │    │      └─ Blob (SQLite, optional)      │ │
│  └─────────────────────────────┘    └──────────────────────────────────────┘ │
│                                                                              │
│  Entra ID                                                                    │
│  ├─ Deploy Plugin app reg   (publisher auth)                                 │
│  ├─ Deploy Portal app reg   (end-user auth — SWA + Container Apps)           │
│  └─ Graph SP                (redirect URI management)                        │
└──────────────────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  End Users                                                                  │
│                                                                             │
│  https://ai-apps.env.fidoo.cloud/{slug}/     ← static apps                  │
│  https://{slug}.api.env.fidoo.cloud/         ← container apps               │
│                                                                             │
│  Both protected by Entra ID login (Deploy Portal app registration)          │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## What It Is

A Claude Code MCP plugin that lets AI assistants deploy apps to Azure with a single tool call. Supports two app types:

- **Static apps** — HTML/JS/CSS served via Azure Static Web Apps at `https://ai-apps.env.fidoo.cloud/{slug}/`
- **Container apps** — Dockerized apps (any language/runtime) served via Azure Container Apps at `https://{slug}.api.env.fidoo.cloud/`

All apps are protected by Entra ID login. No public access.

---

## Azure Resources

| Resource | Name | Purpose |
|---|---|---|
| Static Web App | `swa-ai-apps` | Hosts the dashboard + all static apps |
| Storage Account | `stpublishedapps` | Stores app content ZIPs + registry |
| Blob Container | `app-content` | App ZIP files + `registry.json` |
| Container Apps Environment | `managedEnvironment-rgalipowskitest-adaa` | Shared runtime for container apps |
| Azure Container Registry | `fidooapps` | Docker image storage + build execution |
| User-Assigned Managed Identity | `fidoo-vibe-container-puller` | Lets Container Apps pull images from ACR |
| App Registration: Deploy Plugin | `d98d6d07-...` | OAuth identity for the deploy agent itself |
| App Registration: Deploy Portal | `e6df67bc-...` | Shared identity for end-user login on all deployed apps |
| Service Principal: Graph SP | `f1ddd060-...` | Manages redirect URIs on Deploy Portal via Graph API |
| Resource Group (static) | `rg-published-apps` | SWA + Storage Account |
| Resource Group (container) | `rg-alipowski-test` | ACR + Container Apps Environment |

---

## Authentication Flows

### 1. Publisher Auth — Device Code Flow

Used by the deploy agent to call ARM and Storage APIs on behalf of the publisher.

```
Publisher (Claude Code)
  │
  ├─ auth_login → returns user_code + verification_uri
  │
  ├─ Publisher opens browser, logs into Entra ID
  │
  ├─ auth_poll → exchanges device_code for refresh_token
  │
  └─ Two scoped access tokens derived from refresh_token:
       ├─ access_token       (scope: ARM)     → SWA, Container Apps, ACR management
       └─ storage_access_token (scope: Storage) → Blob read/write
```

Both tokens are cached in `~/.deploy-agent/tokens.json` (mode 0600, auto-refreshed). The ARM token's JWT is decoded to extract the publisher's display name for audit tagging.

**App Registration used:** Deploy Plugin (`DEPLOY_AGENT_CLIENT_ID`)

---

### 2. End-User Auth — SWA Built-in Easy Auth

All routes on `ai-apps.env.fidoo.cloud` require Entra ID login. This is enforced by `staticwebapp.config.json` deployed with the site:

```
Browser → https://ai-apps.env.fidoo.cloud/
  │
  ├─ SWA checks session cookie → not authenticated
  │
  ├─ 401 → redirect to /.auth/login/aad?post_login_redirect_uri=.referrer
  │
  ├─ Entra ID login (MSAL) → redirect to /.auth/login/aad/callback
  │
  └─ SWA sets session → user lands on originally requested page
```

The `/login` page captures the referrer before redirect so users return to the right path after login.

**App Registration used:** Deploy Portal (`PORTAL_CLIENT_ID` / `PORTAL_CLIENT_SECRET` set as SWA app settings)

---

### 3. End-User Auth — Container Apps Easy Auth

Each container app is individually protected by Entra ID via Azure's built-in Easy Auth layer. All container apps share one app registration (Deploy Portal) to avoid creating N app registrations.

```
Browser → https://myapp.api.env.fidoo.cloud/
  │
  ├─ Easy Auth sidecar intercepts → not authenticated
  │
  ├─ Redirect to Entra ID login
  │
  ├─ Entra ID callback → https://myapp.api.env.fidoo.cloud/.auth/login/aad/callback
  │
  └─ Easy Auth sets session → proxies request to container
```

**App Registration used:** Deploy Portal (redirect URI per app is registered at deploy time via Graph SP)

---

### 4. Graph SP — Redirect URI Management

Redirect URIs on the Deploy Portal app registration are managed automatically:

- **Deploy:** Graph SP PATCHes `applications/{objectId}` to add `https://{slug}.api.env.fidoo.cloud/.auth/login/aad/callback`
- **Delete:** Graph SP PATCHes to remove the redirect URI

This uses client credentials flow (no user interaction). Credentials: `DEPLOY_AGENT_GRAPH_SP_CLIENT_ID` / `DEPLOY_AGENT_GRAPH_SP_CLIENT_SECRET`.

---

## Static App Deployment

```
app_deploy /path/to/myapp/
  │
  ├─ 1. Collect files (deny-list: .git, node_modules, .env*, SSH keys)
  │
  ├─ 2. Upload ZIP → Blob Storage (stpublishedapps / app-content / {slug}.zip)
  │
  ├─ 3. Update registry.json in blob (adds slug, name, description, url, deployedAt, deployedBy)
  │
  ├─ 4. Assemble site:
  │      ├─ Download all app ZIPs from blob
  │      ├─ Extract each into /{slug}/ subdirectory
  │      ├─ Generate dashboard index.html (tiles for all apps)
  │      ├─ Generate staticwebapp.config.json (Entra ID auth, route rules)
  │      └─ Generate /login redirect page
  │
  └─ 5. Deploy assembled directory → SWA via StaticSitesClient binary
         (auto-downloaded, cached in ~/.swa/deploy/)
```

**First deploy:** requires `app_name` + `app_description`, generates slug, writes `.deploy.json` to app folder (commit this file).

**Re-deploy:** reads slug from existing `.deploy.json`, overwrites previous content.

**App URL pattern:** `https://ai-apps.env.fidoo.cloud/{slug}/`

---

## Container App Deployment

```
container_deploy /path/to/myapp/
  │
  ├─ 1. Create tarball of source directory
  │
  ├─ 2. Get SAS upload URL from ACR (listBuildSourceUploadUrl ARM API)
  │
  ├─ 3. Upload tarball to Azure Files via SAS URL
  │
  ├─ 4. Trigger ACR Task build (scheduleRun ARM API)
  │      └─ Builds Docker image server-side (no Docker needed locally)
  │         Image tag: fidooapps-d4f2bhfjg2fygqg7.azurecr.io/{slug}:{timestamp}
  │
  ├─ 5. Poll ACR build until succeeded (5s interval, 20min timeout)
  │
  ├─ 6. [If persistent_storage] Create per-app Blob container for SQLite data
  │
  ├─ 7. PUT Container App (ARM API):
  │      ├─ Managed identity for ACR pull (fidoo-vibe-container-puller)
  │      ├─ Ingress: external, targetPort (default 8080)
  │      ├─ Scale: 0–3 replicas (or 1–1 if persistent_storage)
  │      └─ Litestream env vars (if persistent_storage)
  │
  ├─ 8. Wait 5s, then configure Easy Auth:
  │      ├─ Graph SP: add redirect URI to Deploy Portal app registration
  │      ├─ PATCH Container App: inject portal-client-secret
  │      ├─ Poll until Succeeded (prevents race condition)
  │      └─ PUT authConfigs/current: enable Entra ID, RedirectToLoginPage
  │
  ├─ 9. Update registry.json
  │
  └─ 10. Reassemble + redeploy SWA dashboard
```

**App URL pattern:** `https://{slug}.api.env.fidoo.cloud/`

---

## SQLite / Persistent Storage (Litestream)

When a container app needs a persistent SQLite database, set `persistent_storage: true`. The deploy agent:

1. Creates a dedicated Blob container in the Storage Account (`{slug}-data`)
2. Injects environment variables into the Container App:
   - `DATA_DIR=/data` — app writes SQLite here
   - `AZURE_STORAGE_ACCOUNT_NAME` — storage account
   - `AZURE_STORAGE_CONTAINER` — blob container name
   - `AZURE_STORAGE_ACCOUNT_KEY` — storage key (injected as secret reference)
3. Forces `maxReplicas=1` (SQLite can't handle concurrent writers)

The app is expected to run [Litestream](https://litestream.io/) as a sidecar or subprocess to continuously replicate the SQLite file to blob storage. Litestream reads the injected env vars automatically.

---

## DNS Setup

### Static Web App (`ai-apps.env.fidoo.cloud`)

Managed by Azure — the SWA resource automatically provisions a hostname on its default domain, and the custom domain `ai-apps.env.fidoo.cloud` is mapped via CNAME in Azure DNS.

### Container Apps (`*.api.env.fidoo.cloud`)

```
DNS Zone: env.fidoo.cloud (Azure DNS, resource group: shared)

*.api      IN  A    20.113.75.166   ← Container Apps Environment static IP
asuid.api  IN  TXT  37C28DC8...     ← Domain ownership verification (Azure requirement)
```

**Wildcard TLS certificate** (`*.api.env.fidoo.cloud`):
- Issued by Let's Encrypt via acme.sh (DNS-01 challenge, RSA 2048)
- Renewal script: `infra/cert.sh renew`
- Applied to Container Apps Environment via ARM PATCH (`customDomainConfiguration.dnsSuffix`)
- Expiry: ~90 days (Let's Encrypt)

The Environment's `dnsSuffix=api.env.fidoo.cloud` makes every Container App in the environment automatically reachable at `{appname}.api.env.fidoo.cloud`. The wildcard A record routes all traffic to the environment's static IP; the ingress controller routes by hostname to the correct Container App.

---

## App Registrations Summary

| App Registration | Used By | Auth Flow | Purpose |
|---|---|---|---|
| **Deploy Plugin** | Deploy agent (MCP server) | Device code (user) | Call ARM + Storage APIs |
| **Deploy Portal** | SWA + Container Apps | End-user browser login | Protect deployed apps with Entra ID |
| **Graph SP** | Deploy agent (MCP server) | Client credentials | Manage redirect URIs on Deploy Portal |

> The Deploy Portal app registration has its redirect URIs managed automatically. Never manually add/remove them.

---

## RBAC

### Publisher group (`fi-aiapps-pub`)

| Role | Scope | Reason |
|---|---|---|
| Contributor | ACR `fidooapps` | Run ACR Tasks (build + push images) |
| Contributor | Resource group `rg-alipowski-test` | Create / update Container Apps |

### Pull Identity (`fidoo-vibe-container-puller`)

| Role | Scope | Reason |
|---|---|---|
| AcrPull | ACR `fidooapps` | Container Apps pull images at runtime |

Script to apply: `infra/grant-container-permissions.sh`

To onboard a new publisher:
```bash
USER_ID=$(az ad user show --id user@FidooFXtest.onmicrosoft.com --query id -o tsv)
az ad group member add --group fi-aiapps-pub --member-id $USER_ID
```

---

## Key Design Decisions

**Single SWA for all static apps** — path-based routing (`/{slug}/`) avoids per-app SWA resources. The site is reassembled and redeployed on every static app change.

**Registry in blob storage** — `registry.json` is the source of truth. The dashboard is generated from it at deploy time. No database needed.

**Shared Deploy Portal app registration** — one AAD app protects all deployed apps (SWA + every container app). Redirect URIs are managed automatically via Graph SP. This avoids per-app registrations and keeps the auth boundary unified.

**ACR Tasks for container builds** — no Docker daemon required on the publisher's machine. Source is uploaded as a tarball and built server-side.

**Managed identity for ACR pull** — no credentials stored in Container App config. The `fidoo-vibe-container-puller` identity has AcrPull and is assigned at the environment level.

**Litestream for SQLite persistence** — Azure Container Apps don't support persistent volumes natively in consumption tier. Blob storage + Litestream replication gives SQLite-based apps durable storage without a managed database.

**Zero runtime npm dependencies** — OAuth, ZIP, REST client, HMAC-SHA256 SAS signing all hand-rolled in TypeScript. Keeps the plugin lightweight and avoids supply chain risk.
