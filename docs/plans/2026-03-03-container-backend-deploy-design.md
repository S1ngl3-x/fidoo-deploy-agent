# Container Backend Deploy — Design Document

**Date:** 2026-03-03
**Status:** Approved
**Extends:** [2026-02-27-single-domain-path-routing-design.md](2026-02-27-single-domain-path-routing-design.md)

---

## Problem

The deploy agent supports static HTML/JS apps only. Advanced users (developers capable of writing a Dockerfile) need a way to deploy container-based backends — Node.js APIs, Python services, etc. — to Azure, with the same simple "say deploy, it deploys" experience as static apps.

## Constraints

- Users have source code + Dockerfile but no Docker installed locally
- Bitbucket is the company standard Git host (GitHub Actions not available)
- Azure Container Registry (ACR) already exists
- Azure Container Apps Environment does not yet exist — provisioned once by admin
- Container backends must have Entra ID auth (same as static apps)
- Custom domains under `env.fidoo.cloud` — DNS must not require per-app changes
- Extend the existing deploy agent; do not create a separate agent
- Maintain zero runtime npm dependencies

---

## Approach

**Build mechanism: ACR Tasks (cloud build, no Docker locally required)**

The agent packages source files as a tar.gz, uploads to Blob Storage, and triggers an ACR Task via the ARM API using a SAS URL as the build context. ACR builds the Docker image inside Azure and stores it in the registry. No CI/CD pipeline setup needed, no Bitbucket Pipelines configuration, no Docker daemon on the developer's machine.

**Domain strategy: Container Apps Environment wildcard domain (no per-app DNS)**

The Container Apps Environment is configured once by admin with a custom domain suffix. A single wildcard CNAME `*.api.env.fidoo.cloud` → the Environment FQDN means every Container App in that environment automatically gets `{slug}.api.env.fidoo.cloud` — no per-app DNS writes. This mirrors the single-SWA approach for static apps: DNS is touched once by admin, never by the agent.

Container backend URLs: `https://{slug}.api.env.fidoo.cloud`
Static app URLs: `https://ai-apps.env.fidoo.cloud/{slug}/`

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Claude Code                                                  │
│  ┌──────────────┐   ┌─────────────────────────────────────┐  │
│  │  deploy.md   │   │  MCP Server (extended)              │  │
│  │  (skill)     │──▶│  app_deploy / app_delete (static)   │  │
│  │              │   │  container_deploy / container_delete │  │
│  └──────────────┘   └──────────────────┬────────────────── ┘  │
└─────────────────────────────────────── │ ────────────────────┘
                                         │ ARM + ACR REST API
                                         ▼
┌──────────────────────────────────────────────────────────────┐
│  Azure                                                        │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  Blob Storage (existing)                             │    │
│  │  app-content/                                        │    │
│  │    {slug}/...          ← static app files            │    │
│  │    container-builds/   ← source tarballs (temp)      │    │
│  │    registry.json       ← unified app registry        │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  Azure Container Registry (existing)                 │    │
│  │  myacr.azurecr.io/{slug}:{timestamp}                 │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  Container Apps Environment (new, provisioned once)  │    │
│  │  Domain suffix: api.env.fidoo.cloud                  │    │
│  │  ┌─────────────────────────────────────────────────┐ │    │
│  │  │  Container App: expense-api                     │ │    │
│  │  │  https://expense-api.api.env.fidoo.cloud        │ │    │
│  │  │  Image: myacr.azurecr.io/expense-api:{ts}       │ │    │
│  │  │  Entra ID auth (EasyAuth)                       │ │    │
│  │  └─────────────────────────────────────────────────┘ │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  Static Web App (existing, single)                   │    │
│  │  https://ai-apps.env.fidoo.cloud/                    │    │
│  │    /                    ← dashboard (all apps + APIs)│    │
│  │    /expense-tracker/    ← static app                 │    │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

---

## New MCP Tools

| Tool | Purpose |
|---|---|
| `container_deploy` | First deploy or re-deploy a container backend via ACR Tasks |
| `container_delete` | Delete a Container App and remove from registry + dashboard |

Existing tools `app_list`, `app_info`, `app_update_info` are **extended** to handle both `"static"` and `"container"` registry entries — no new list/info/update tools.

### First Deploy Inputs

```
Required (prompted on first deploy only):
  app_name         — display name ("Expense API")
  app_description  — dashboard description
  port             — port the container listens on (default: 8080)

Auto-detected from folder:
  slug             — kebab-cased from app_name, verified unique
  image            — myacr.azurecr.io/{slug}
```

### Re-Deploy

Reads `.deploy.json` silently. No questions asked.

---

## Deploy Flow

### First Deploy

```
1.  No .deploy.json → ask: app_name, app_description, port
2.  Generate slug (kebab-case, check uniqueness in registry)
3.  Verify Dockerfile exists at project root (hard fail if missing)
4.  collectFiles() with extended deny-list (see below)
5.  Package as tar.gz (new: src/deploy/tarball.ts)
6.  Upload tar.gz to blob: container-builds/{slug}/source-{ts}.tar.gz
7.  Generate SAS URL for the tarball (User Delegation SAS, 1h expiry)
8.  POST ARM scheduleRun to ACR — DockerBuildRequest:
      sourceLocation: {SAS URL}
      imageNames: ["{slug}:{ts}"]
      dockerFilePath: "Dockerfile"
      platform: { os: "Linux", architecture: "amd64" }
9.  Poll ACR run status until Succeeded/Failed (~1-3 min)
      Stream log lines to user as progress
10. Create Container App via ARM:
      image: myacr.azurecr.io/{slug}:{ts}
      ingress: external, targetPort: {port}
      scale: minReplicas 0, maxReplicas 3
11. Configure Entra ID EasyAuth on Container App (ARM authConfigs)
      Reuse same portal AAD app registration as SWA
12. Write .deploy.json to project folder
13. upsertApp() in registry.json (type: "container")
14. Rebuild + redeploy dashboard (SWA)
15. Delete source tarball from blob (cleanup)

Output: "Deployed! https://{slug}.api.env.fidoo.cloud"
```

### Re-Deploy

```
1.  Read .deploy.json (slug, containerAppId, imageRepository)
2.  collectFiles() + tar.gz
3.  Upload to blob + generate SAS URL
4.  POST ARM scheduleRun (same as steps 8-9 above)
5.  Update Container App image via ARM (new revision, traffic 100%)
6.  Update registry.json (deployedAt, deployedBy)
7.  Rebuild + redeploy dashboard
8.  Delete source tarball from blob

Output: "Updated! https://{slug}.api.env.fidoo.cloud"
```

### Delete

```
1.  Read registry.json, find entry by slug
2.  DELETE Container App via ARM
3.  removeApp() from registry.json
4.  Rebuild + redeploy dashboard

Output: "Deleted {slug}. Dashboard updated."
```

---

## ACR Tasks Build Detail

ACR Tasks is Azure's built-in cloud build system, triggered via the ARM API.

**Source delivery:** The agent uploads source files to Blob Storage and generates a 1-hour User Delegation SAS URL. The ARM `scheduleRun` API accepts this URL directly as `sourceLocation` — ACR downloads and unpacks the tarball to use as the Docker build context. No Docker daemon or ACR CLI needed.

**Auth:** Uses the existing ARM access token — no separate ACR token required to trigger a Task. The ARM token needs `AcrPush` role on the ACR resource (added to the Deploy Plugin app registration in setup).

**Image tagging:** `{slug}:{ts}` where `{ts}` is a Unix timestamp. The Container App always points to the latest tag. Old images accumulate in ACR (manual cleanup out of scope for v1).

**Build duration:** Typically 1–3 minutes. First build is slower (no layer cache). ACR caches layers between builds for the same slug. Billed at ~$0.0001/second (negligible).

**Dockerfile requirement:** The Dockerfile must exist at the project root. The agent validates this before tarball creation and returns a clear error if missing.

---

## Source File Collection (Deny-list)

Extended from the static deploy deny-list:

```
# Existing (static)
.git/
node_modules/
.deploy.json
.env
.env.*
*.pem, *.key, *.p12, id_rsa, id_ed25519

# Added for containers
__pycache__/
*.pyc
.venv/
venv/
.gradle/
target/          # Maven/Gradle build output
*.class
dist/            # pre-built output (ACR builds it fresh)
.DS_Store
```

---

## Registry Schema Changes

`registry.json` gains a `type` field. All existing static entries default to `"static"` on first read (backwards-compatible):

```json
{
  "apps": [
    {
      "slug": "expense-tracker",
      "type": "static",
      "name": "Expense Tracker",
      "description": "Submit and approve team expenses",
      "url": "https://ai-apps.env.fidoo.cloud/expense-tracker/",
      "deployedAt": "2026-03-01T10:00:00Z",
      "deployedBy": "user@fidoo.cloud"
    },
    {
      "slug": "expense-api",
      "type": "container",
      "name": "Expense API",
      "description": "Backend for the Expense Tracker",
      "url": "https://expense-api.api.env.fidoo.cloud",
      "containerAppId": "/subscriptions/.../containerApps/expense-api",
      "imageRepository": "myacr.azurecr.io/expense-api",
      "deployedAt": "2026-03-03T14:00:00Z",
      "deployedBy": "dev@fidoo.cloud"
    }
  ]
}
```

`AppEntry` in `src/deploy/registry.ts` gains:
- `type: "static" | "container"` (required, default `"static"` on read)
- `url: string` (was implicit before, now explicit in registry)
- `containerAppId?: string` (container only)
- `imageRepository?: string` (container only)

---

## Local Config: .deploy.json (container variant)

```json
{
  "appSlug": "expense-api",
  "appType": "container",
  "appName": "Expense API",
  "appDescription": "Backend for the Expense Tracker",
  "containerAppId": "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.App/containerApps/expense-api",
  "imageRepository": "myacr.azurecr.io/expense-api"
}
```

The static `.deploy.json` gains `"appType": "static"` for explicitness, but the agent treats an absent `appType` as `"static"` (backwards-compatible).

---

## Dashboard Changes

The dashboard (`src/deploy/dashboard.ts`) currently lists only static apps. It is extended to:

- Display both `"static"` and `"container"` entries from `registry.json`
- Show a type badge per entry: `App` (static) / `API` (container)
- Group by type or sort alphabetically (TBD at implementation)

No changes to how the dashboard is deployed — it remains part of the SWA assembly on every deploy.

---

## Entra ID Auth on Container Apps

Container Apps supports built-in EasyAuth, configured via ARM at:
`PUT /subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.App/containerApps/{name}/authConfigs/current`

The same "Deploy Portal" AAD app registration already used for SWA auth is reused. This means anyone with `app_subscriber` access to static apps also has access to container backends — no separate role setup needed.

The EasyAuth config redirects unauthenticated requests to the Entra ID login page and validates tokens on the Container App sidecar. The container itself receives authenticated requests with standard `X-MS-CLIENT-PRINCIPAL-*` headers.

---

## Container Apps Environment — Custom Domain Setup

**Admin one-time setup (added to `setup.sh`):**

1. Provision Container Apps Environment in `{resource-group}`
2. Retrieve the Environment's default domain (e.g., `{env-name}.{region}.azurecontainerapps.io`)
3. Add DNS record (manual or via setup script): `*.api CNAME {env-name}.{region}.azurecontainerapps.io`
4. Configure Environment custom domain suffix: `api.env.fidoo.cloud`
5. Provision TLS cert for `*.api.env.fidoo.cloud` (managed cert or Let's Encrypt)

After setup: every Container App deployed in this Environment automatically gets `{slug}.api.env.fidoo.cloud` — **the agent never touches DNS**.

---

## New Configuration Variables

| Variable | Description | Default |
|---|---|---|
| `DEPLOY_AGENT_ACR_NAME` | Azure Container Registry resource name | (required for container deploy) |
| `DEPLOY_AGENT_ACR_RESOURCE_GROUP` | Resource group containing the ACR | defaults to `DEPLOY_AGENT_RESOURCE_GROUP` |
| `DEPLOY_AGENT_CONTAINER_ENV_NAME` | Container Apps Environment name | (required for container deploy) |
| `DEPLOY_AGENT_CONTAINER_ENV_RG` | Resource group for Container Apps Environment | defaults to `DEPLOY_AGENT_RESOURCE_GROUP` |
| `DEPLOY_AGENT_CONTAINER_DOMAIN` | Custom domain for container backends | `api.env.fidoo.cloud` |
| `DEPLOY_AGENT_DEFAULT_PORT` | Default container listen port if not specified | `8080` |

Container deploy variables are only required when `container_deploy` or `container_delete` is called. Static-only users are unaffected.

---

## New ARM Token Scopes

The Deploy Plugin app registration needs two additional RBAC assignments:

| Resource | Role |
|---|---|
| ACR resource | `AcrPush` |
| Container Apps Environment | `Contributor` |

Added to `setup.sh`. No changes to the OAuth device code flow — same scopes, same token.

---

## File Changes

### New files

| File | Purpose |
|---|---|
| `src/deploy/tarball.ts` | Create tar.gz from file list (mirrors `zip.ts` for static) |
| `src/azure/container-apps.ts` | ARM REST calls: create/update/delete Container App, configure EasyAuth |
| `src/azure/acr.ts` | ARM REST calls: scheduleRun, poll run status, stream logs |
| `src/azure/sas.ts` | Generate User Delegation SAS URL for blob storage |
| `src/tools/container-deploy.ts` | `container_deploy` tool handler |
| `src/tools/container-delete.ts` | `container_delete` tool handler |

### Modified files

| File | Change |
|---|---|
| `src/deploy/registry.ts` | Add `type`, `url`, `containerAppId`, `imageRepository` to `AppEntry` |
| `src/deploy/dashboard.ts` | Render both static and container entries with type badge |
| `src/deploy/deploy-json.ts` | Add `appType` field; backwards-compat read |
| `src/tools/index.ts` | Register `container_deploy`, `container_delete` |
| `src/tools/app-list.ts` | Show both types from registry |
| `src/tools/app-info.ts` | Handle container fields |
| `src/tools/app-update-info.ts` | Allow update for both types |
| `src/config.ts` | New env vars for ACR + Container Apps |
| `infra/setup.sh` | Provision Container Apps Environment, set RBAC |

---

## Security Considerations

### Source tarball in blob storage
The source tarball contains all application source code. It is uploaded with a private blob (no anonymous access), and deleted after the ACR build completes. The SAS URL is scoped to 1 hour read access on that specific blob.

### Image accumulation in ACR
Each deploy pushes a new tagged image. Old images are not deleted automatically in v1. Admins should set up ACR lifecycle policies to prune old tags.

### Container App network exposure
Container Apps with `ingress: external` are publicly reachable at the network level. Entra ID EasyAuth provides the auth gate. The container does not need to implement its own auth, but developers should be aware that requests reaching the container have already been authenticated.

### No secrets injection at build time
ACR Tasks `buildArguments` can pass `--build-arg` values. If a backend requires private package registry tokens at build time (e.g., private npm/pip), this is out of scope for v1. Users must bake credentials into the image (not recommended) or use multi-stage builds pulling from public registries.

---

## Out of Scope (v1)

- Automatic re-deploy on Bitbucket push (no Bitbucket Pipelines integration)
- Environment variables / secrets injection into Container App at deploy time
- Port auto-detection from Dockerfile (user specifies port)
- ACR image cleanup / lifecycle policy
- Container App scaling configuration beyond the 0–3 default
- Health check / readiness probe configuration
- Private networking (VNet integration)
- Multi-container apps (sidecars, init containers)
