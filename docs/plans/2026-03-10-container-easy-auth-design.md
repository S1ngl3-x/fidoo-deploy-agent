# Easy Auth for Container Apps

## Problem

Static apps share one SWA domain (`ai-apps.env.fidoo.cloud/{slug}/`) with a single Entra ID app registration ("Deploy Portal"). All static apps get auth for free.

Container apps each get their own domain (`{slug}.blueground-....azurecontainerapps.io`). They are currently **unauthenticated** — anyone with the URL can access them. Each container app is a separate origin, so the SWA auth boundary doesn't cover them.

The dashboard links to container apps via their external URL (`app.url`), which means clicking a container app card from the authenticated dashboard lands on an unauthenticated app.

## Approach: Easy Auth per Container App

Azure Container Apps supports built-in authentication ("Easy Auth") — the same mechanism SWA uses. We reuse the existing **Deploy Portal** AD app registration so all apps (static + container) share one auth boundary.

### Why this approach

- No new infrastructure (no Front Door, no reverse proxy)
- Reuses existing AD app registration — no per-app AD setup
- Same auth UX as static apps (redirect to Entra ID login, then back)
- Container app receives `X-MS-CLIENT-PRINCIPAL-*` headers for free

### What changes

#### 1. `src/config.ts` — new optional env vars

```typescript
portalClientId:     process.env.DEPLOY_AGENT_PORTAL_CLIENT_ID     ?? "",
portalClientSecret: process.env.DEPLOY_AGENT_PORTAL_CLIENT_SECRET ?? "",
```

Empty by default — Easy Auth is skipped when not configured.

#### 2. `src/azure/container-apps.ts` — new `configureEasyAuth()` function

```
PUT /subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.App/containerApps/{name}/authConfigs/current?api-version=2024-03-01
```

Request body:

```json
{
  "properties": {
    "platform": {
      "enabled": true
    },
    "globalValidation": {
      "unauthenticatedClientAction": "RedirectToLoginPage",
      "redirectToProvider": "azureactivedirectory"
    },
    "identityProviders": {
      "azureActiveDirectory": {
        "registration": {
          "openIdIssuerUrl": "https://login.microsoftonline.com/{tenantId}/v2.0",
          "clientId": "{portalClientId}",
          "clientSecretSettingName": "PORTAL_CLIENT_SECRET"
        },
        "validation": {
          "allowedAudiences": ["{portalClientId}"]
        }
      }
    }
  }
}
```

The portal client secret must be stored as a Container App secret named `PORTAL_CLIENT_SECRET` (set during `createOrUpdateContainerApp`).

#### 3. `src/tools/container-deploy.ts` — call `configureEasyAuth()` after app creation

Only when `portalClientId` is set. Silent skip otherwise (same pattern as dashboard rebuild).

#### 4. AD redirect URI management

On first deploy, add `https://{app-fqdn}/.auth/login/aad/callback` to the Deploy Portal AD app's redirect URIs. This requires Microsoft Graph API:

```
PATCH https://graph.microsoft.com/v1.0/applications/{object-id}
```

With the new redirect URI appended to `web.redirectUris`.

This step requires `Application.ReadWrite.All` permission on the Graph API scope. The deploy agent's device code flow would need to request this scope, or the redirect URIs could be managed manually / via infra setup.

### What gets skipped for now

- Wiring `DEPLOY_AGENT_PORTAL_CLIENT_ID` / `SECRET` into `.mcp.json`
- End-to-end testing of the auth flow
- Graph API call for redirect URIs (needs AD permissions discussion)
- Token scope expansion for Graph API access

### Dependencies

- `DEPLOY_AGENT_PORTAL_CLIENT_ID` — the Deploy Portal app registration client ID (same one used by SWA)
- `DEPLOY_AGENT_PORTAL_CLIENT_SECRET` — the client secret for that app
- Both values are currently stored as SWA app settings in the production environment

### Future considerations

- If the number of container apps grows large, the redirect URIs list on the AD app grows too. Azure has a limit of ~256 redirect URIs per app registration. A reverse proxy / Front Door approach would be needed at that scale.
- Consider automating redirect URI cleanup on `container_delete`.
