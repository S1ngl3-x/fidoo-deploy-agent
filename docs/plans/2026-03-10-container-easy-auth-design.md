# Easy Auth for Container Apps — Design Document

**Date:** 2026-03-10
**Status:** Approved
**Extends:** [2026-03-03-container-backend-deploy-design.md](2026-03-03-container-backend-deploy-design.md)

---

## Problem

Static apps share one SWA domain (`ai-apps.env.fidoo.cloud/{slug}/`) protected by a single Entra ID
app registration ("Deploy Portal"). All static apps get auth for free — one login covers all of them.

Container apps each get their own domain (`{slug}.api.env.fidoo.cloud`). They are currently
**unauthenticated** — anyone with the URL can access them. Each container app is a separate origin,
so the SWA auth boundary does not cover them.

---

## Goals

- Any valid Entra ID user in the Fidoo tenant can access container apps (same policy as static apps)
- From the user's perspective: the experience mirrors static apps — redirected to Entra ID on first
  visit, then straight through on subsequent visits
- No manual steps for developers on each deploy — auth is configured automatically by the deploy agent
- No new infrastructure (no Front Door, no reverse proxy)

---

## URL Scheme

Container apps use a wildcard subdomain per app:

```
https://{slug}.api.env.fidoo.cloud
```

This mirrors the static app pattern (`ai-apps.env.fidoo.cloud/{slug}/`) but at the DNS level — a
single wildcard CNAME covers all container apps. The deploy agent never touches DNS.

**One-time admin setup** (added to `setup.sh`):

1. Configure Container Apps Environment custom domain suffix: `api.env.fidoo.cloud`
2. Add wildcard TLS cert for `*.api.env.fidoo.cloud` to the Environment
3. Add DNS record: `*.api CNAME {env-fqdn}.germanywestcentral.azurecontainerapps.io`

After this, every Container App in the Environment automatically gets `{slug}.api.env.fidoo.cloud`.
The agent never touches DNS.

---

## Authentication Flow

Azure Container Apps supports built-in authentication ("Easy Auth") — the same mechanism SWA uses.
We reuse the existing **Deploy Portal** AAD app registration so all apps (static + container) share
one identity provider.

### First visit to a container app (cold start)

```
User clicks container app link on dashboard
        │
        ▼
{slug}.api.env.fidoo.cloud
        │  Easy Auth sidecar: no session cookie
        ▼
login.microsoftonline.com   ← full Entra ID login (username + MFA)
        │
        ▼
{slug}.api.env.fidoo.cloud/.auth/login/aad/callback
        │  Easy Auth: exchange code → set session cookie on {slug}.api.env.fidoo.cloud
        ▼
{slug}.api.env.fidoo.cloud  ← user sees the app
```

### Subsequent container app (same browser session)

The user already has an AAD session at `login.microsoftonline.com`. Visiting a different container
app triggers a silent redirect — no login prompt, ~1 second bounce:

```
User clicks a different container app
        │
        ▼
other-app.api.env.fidoo.cloud
        │  Easy Auth: no session cookie on this domain
        ▼
login.microsoftonline.com   ← AAD sees existing SSO session → silent, no prompt
        │
        ▼
other-app.api.env.fidoo.cloud/.auth/login/aad/callback
        │  sets session cookie
        ▼
other-app.api.env.fidoo.cloud
```

### SSO behaviour summary

| | Static apps | Container apps |
|---|---|---|
| Cookie scope | shared `ai-apps.env.fidoo.cloud` | per-app `{slug}.api.env.fidoo.cloud` |
| After first ever login | no redirects | silent 1s redirect per new app domain |
| Password / MFA prompt | once ever | once ever (AAD session reused) |

### What the container receives

Once authenticated, the Easy Auth sidecar passes requests through with standard headers. The
container does not implement any auth itself:

```
X-MS-CLIENT-PRINCIPAL-NAME: user@fidoo.cloud
X-MS-CLIENT-PRINCIPAL-ID:   <oid>
X-MS-CLIENT-PRINCIPAL:      <base64 claims JSON>
```

---

## Redirect URI Problem

For Easy Auth to work, Azure requires `https://{slug}.api.env.fidoo.cloud/.auth/login/aad/callback`
to be registered as a redirect URI in the Deploy Portal AAD app registration.

Static apps needed only one URI (one domain). Container apps each need their own URI — one per slug.

### Solution: Dedicated Graph Service Principal

A dedicated "Graph SP" app registration handles redirect URI management. It has
`Application.ReadWrite.OwnedBy` permission on the Deploy Portal app registration (the minimum scope
needed — it can only modify apps it owns).

The deploy agent calls the Graph API with this SP's client credentials on each container deploy and
delete. The user's device-code OAuth flow is unchanged — no elevated scopes for the developer.

**Why not expand the user's device-code flow scope?**
`Application.ReadWrite.All` on the user token is a high-privilege scope. Using a dedicated SP keeps
the user's credentials minimal and the Graph write access auditable as infrastructure.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  container_deploy tool                                   │
│                                                          │
│  1. Build image via ACR Tasks (existing)                 │
│  2. Create/update Container App via ARM (existing)       │
│  3. configureEasyAuth(token, slug)          ← extended   │
│       a. Acquire Graph token (client creds, Graph SP)    │
│       b. PATCH Graph: add redirect URI                   │
│       c. PATCH Container App: add portal-client-secret   │
│       d. PUT authConfigs/current on Container App        │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  container_delete tool                                   │
│                                                          │
│  1. removeEasyAuth(slug)                  ← new          │
│       a. Acquire Graph token (client creds, Graph SP)    │
│       b. PATCH Graph: remove redirect URI                │
│  2. DELETE Container App via ARM (existing)              │
└─────────────────────────────────────────────────────────┘
```

---

## New Configuration Variables

| Variable | Description |
|---|---|
| `DEPLOY_AGENT_PORTAL_CLIENT_ID` | Deploy Portal AAD app client ID (already used by SWA) |
| `DEPLOY_AGENT_PORTAL_CLIENT_SECRET` | Deploy Portal client secret (already used by SWA) |
| `DEPLOY_AGENT_PORTAL_OBJECT_ID` | Deploy Portal AAD app **object ID** (needed for Graph PATCH) |
| `DEPLOY_AGENT_GRAPH_SP_CLIENT_ID` | Graph SP client ID |
| `DEPLOY_AGENT_GRAPH_SP_CLIENT_SECRET` | Graph SP client secret |

All five are optional. When `DEPLOY_AGENT_PORTAL_CLIENT_ID` or `DEPLOY_AGENT_GRAPH_SP_CLIENT_ID`
is absent, Easy Auth is silently skipped (same pattern as dashboard rebuild).

---

## New File: `src/auth/graph-token.ts`

Acquires a Graph API token via client credentials flow (no user interaction):

```
POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token
  grant_type=client_credentials
  client_id={graphSpClientId}
  client_secret={graphSpClientSecret}
  scope=https://graph.microsoft.com/.default
```

Returns a short-lived access token. Called once per deploy/delete — no caching needed.

---

## Updated `configureEasyAuth()` in `src/azure/container-apps.ts`

Already in the PR (ARM authConfigs call + secret injection). Extended with:

**Step added before ARM call:**

```
PATCH https://graph.microsoft.com/v1.0/applications/{portalObjectId}
  {
    "web": {
      "redirectUris": [
        ...existing,
        "https://{slug}.api.env.fidoo.cloud/.auth/login/aad/callback"
      ]
    }
  }
```

Uses Graph SP token. Reads existing URIs first to avoid duplicates (idempotent on re-deploy).

---

## New `removeEasyAuth()` in `src/azure/container-apps.ts`

Called from `container_delete` before the Container App is deleted:

```
PATCH https://graph.microsoft.com/v1.0/applications/{portalObjectId}
  {
    "web": {
      "redirectUris": [ ...existing without this app's URI ]
    }
  }
```

Keeps the Deploy Portal app registration clean as apps are removed.

---

## One-Time Setup (`setup.sh` additions)

```bash
# 1. Create Graph SP app registration
GRAPH_SP_APP_ID=$(az ad app create --display-name "Deploy Agent Graph SP" \
  --query appId -o tsv)
GRAPH_SP_OBJECT_ID=$(az ad sp create --id $GRAPH_SP_APP_ID --query id -o tsv)
GRAPH_SP_SECRET=$(az ad app credential reset --id $GRAPH_SP_APP_ID \
  --query password -o tsv)

# 2. Add Application.ReadWrite.OwnedBy permission on Graph SP
az ad app permission add --id $GRAPH_SP_APP_ID \
  --api 00000003-0000-0000-c000-000000000000 \
  --api-permissions 18a4783c-866b-4cc7-a460-3d5e5662c884=Role
az ad app permission admin-consent --id $GRAPH_SP_APP_ID

# 3. Add Graph SP as owner of Deploy Portal app registration
PORTAL_OBJECT_ID=$(az ad app show --id $PORTAL_CLIENT_ID --query id -o tsv)
az ad app owner add --id $PORTAL_OBJECT_ID --owner-object-id $GRAPH_SP_OBJECT_ID

# 4. Configure Container Apps Environment custom domain (manual: DNS + cert required first)
az containerapp env update \
  --name $CONTAINER_ENV_NAME \
  --resource-group $RESOURCE_GROUP \
  --custom-domain-dnssuffix api.env.fidoo.cloud \
  --custom-domain-certificate-password "" \
  --custom-domain-certificate-file ./wildcard-api-cert.pfx
```

---

## File Changes

### New files

| File | Purpose |
|---|---|
| `src/auth/graph-token.ts` | Client credentials token acquisition for Graph API |

### Modified files

| File | Change |
|---|---|
| `src/azure/container-apps.ts` | Add Graph redirect URI step to `configureEasyAuth()`; add `removeEasyAuth()` |
| `src/tools/container-delete.ts` | Call `removeEasyAuth()` before deleting the Container App |
| `src/config.ts` | Add `portalObjectId`, `graphSpClientId`, `graphSpClientSecret` |
| `infra/setup.sh` | Graph SP creation, ownership assignment, Container Apps Environment custom domain |

---

## Security Considerations

### Graph SP privilege scope
The Graph SP holds `Application.ReadWrite.OwnedBy` — it can only modify app registrations that it
owns. It owns exactly one: the Deploy Portal app. Compromise of the Graph SP credentials allows an
attacker to add redirect URIs to the Deploy Portal app, which could be used to steal auth codes for
all apps (static + container). Treat `DEPLOY_AGENT_GRAPH_SP_CLIENT_SECRET` with the same care as
the Portal client secret.

### Redirect URI list growth
Azure supports ~256 redirect URIs per app registration. At one URI per container app, this limit
is not a concern at current scale. If the limit is ever approached, the solution is Azure Front Door
with path-based routing (one redirect URI total).

### Redirect URI cleanup
`removeEasyAuth()` removes the redirect URI on `container_delete`. If a container app is deleted
outside the deploy agent (e.g. directly via Azure portal), the orphaned redirect URI remains in the
Deploy Portal app. This is harmless (AAD ignores URIs for non-existent apps) but should be cleaned
up periodically.

---

## Out of Scope

- Group-based access control (current: whole-tenant access, same as static apps)
- Automatic redirect URI cleanup for apps deleted outside the deploy agent
- Front Door / path-based routing (revisit if redirect URI limit is approached)
