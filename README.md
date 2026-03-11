# Deploy Agent

Claude Code plugin for deploying static HTML/JS apps to Azure Static Web Apps with Entra ID authentication.

## Install

```bash
/plugin marketplace add peterhora/fidoo-deploy-agent
/plugin install deploy-agent@fidoo-deploy
```

That's it. The `dist/` folder is shipped in the repo, so no build step is needed. Claude Code auto-discovers the plugin manifest and MCP server.

## Azure Requirements

### For publishers (deploy apps)

1. **A Fidoo FX Test tenant account** (`@FidooFXtest.onmicrosoft.com`)
2. **Membership in the `fi-aiapps-pub` security group** — an admin adds you with:

```bash
az ad group member add --group fi-aiapps-pub --member-id <user-object-id>
```

The group has the required Azure RBAC roles (Storage Blob Data Contributor on storage, Contributor on SWA).

### For viewers (browse apps)

Any Entra ID user — including B2B guests (`user@fidoo.com` appearing as `#EXT#` in FidooFXtest) — can view deployed apps. Log in with Entra ID when prompted. No group membership needed.

### For admins (one-time setup)

The infrastructure is already provisioned. To re-run or set up in a new tenant:

```bash
az login
./infra/setup.sh
```

The script is idempotent and creates/configures:

| Step | What it does |
|------|-------------|
| Resource group | `rg-published-apps` in `westeurope` |
| Deploy Plugin app | App registration for MCP agent OAuth (device code flow); API permissions for Azure Service Management and Azure Storage; `app_publisher` role |
| Deploy Portal app | Single-tenant web app used by SWA for portal visitor authentication; redirect URIs configured; client secret generated (printed once — see below) |
| Storage account | `stpublishedapps` with `app-content` blob container |
| Static Web App | `swa-ai-apps` (Free SKU) |
| SWA app settings | `PORTAL_CLIENT_ID` and `PORTAL_CLIENT_SECRET` set on the SWA |
| SWA authsettingsV2 | Configures the Deploy Portal app as the AAD identity provider; unauthenticated requests redirected to login |
| Security group & RBAC | `fi-aiapps-pub` group with Storage Blob Data Contributor on storage and Contributor on the SWA |

**`PORTAL_CLIENT_SECRET`** is printed once during setup. Store it in a vault immediately. It is saved automatically as a SWA app setting by the script, but is not written to `infra/.env`. To rotate it:

```bash
az ad app credential reset --id <DEPLOY_PORTAL_APP_ID> --display-name swa-auth --years 2
# Then re-run setup.sh to push the new secret to SWA app settings
```

**Admin consent:** The `az ad app permission admin-consent` step requires Global Administrator or Privileged Role Administrator. If it fails, grant consent manually in the Azure Portal: **Entra ID** > **App registrations** > **Deploy Plugin** > **API permissions** > **Grant admin consent**. Both Azure Service Management and Azure Storage `user_impersonation` permissions must be consented.

DNS: CNAME `ai-apps.env.fidoo.cloud` pointing to the SWA default hostname, then add the custom domain to the SWA.

### Container Apps RBAC (one-time admin setup)

The `fi-aiapps-pub` group needs Contributor on both the ACR and the Container Apps Environment
to deploy container apps. Run once after `setup.sh`:

```bash
./infra/grant-container-permissions.sh
```

Requires Owner or User Access Administrator on `rg-alipowski-test`.

### Onboarding a new publisher

```bash
# Get the user's object ID
USER_ID=$(az ad user show --id user@FidooFXtest.onmicrosoft.com --query id -o tsv)

# Add them to the publisher group (grants all required RBAC roles)
az ad group member add --group fi-aiapps-pub --member-id "$USER_ID"
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `auth_status` | Check if user has a valid Azure token |
| `auth_login` | Start device code flow (returns URL + code) |
| `auth_poll` | Poll for token after browser login |
| `app_deploy` | Deploy a static app (first deploy or update) |
| `app_delete` | Remove an app and redeploy site |
| `app_list` | List all deployed apps |
| `app_info` | Get app details (URL, metadata) |
| `app_update_info` | Change app name/description without redeploying code |

## Development

```bash
npm install        # Install devDependencies (typescript, @types/node)
npm run build      # Compile TypeScript to dist/
npm run dev        # Watch mode
npm test           # Run tests (requires build first)
```
