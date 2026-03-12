# Deploy Agent

Claude Code plugin for deploying apps to Azure — static HTML/JS apps to Azure Static Web Apps, and fullstack container apps to Azure Container Apps. All with Entra ID authentication.

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

The group has the required Azure RBAC roles (Storage Blob Data Contributor on storage, Contributor on SWA, Contributor on ACR and Container Apps resource group).

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
| Deploy Plugin app | App registration for MCP agent OAuth (device code flow); API permissions for Azure Service Management, Azure Storage, and Azure Key Vault; `app_publisher` role |
| Deploy Portal app | Single-tenant web app used by SWA for portal visitor authentication; redirect URIs configured; client secret generated (printed once — see below) |
| Storage account | `stpublishedapps` with `app-content` blob container |
| Static Web App | `swa-ai-apps` (Free SKU) |
| SWA app settings | `PORTAL_CLIENT_ID` and `PORTAL_CLIENT_SECRET` set on the SWA |
| SWA authsettingsV2 | Configures the Deploy Portal app as the AAD identity provider; unauthenticated requests redirected to login |
| Security group & RBAC | `fi-aiapps-pub` group with Storage Blob Data Contributor on storage and Contributor on the SWA |

### Azure Infrastructure Inventory

All resources are manually provisioned (no IaC). This is the current footprint:

| Resource | Name | Resource Group | Purpose |
|----------|------|----------------|---------|
| **Resource Group** | `rg-published-apps` | — | Static apps, SWA, storage, ACR |
| **Resource Group** | `rg-alipowski-test` | — | Container Apps, Container Environment |
| **Storage Account** | `fidoovibestorage` | `rg-published-apps` | Blob storage for static app content + registry.json |
| **Static Web App** | `swa-ai-apps` | `rg-published-apps` | Hosts all static apps + dashboard |
| **Container Registry** | `fidooapps` | `rg-alipowski-test` | Docker images for container apps |
| **Container Environment** | `fidoo-vibe-env` | `rg-alipowski-test` | Hosts all container apps |
| **Key Vault** | `kv-fidoo-vibe-deploy2` | `rg-alipowski-test` | Runtime secrets (RBAC access model) |
| **Managed Identity** | `fidoo-vibe-container-puller` | `rg-published-apps` | AcrPull for Container Apps |
| **App Registration** | Deploy Plugin | — | MCP agent OAuth (device code flow) |
| **App Registration** | Deploy Portal | — | Entra ID auth for SWA + Container Apps |
| **App Registration** | Deploy Agent Graph SP | — | Redirect URI management on Deploy Portal app |
| **Security Group** | `fi-aiapps-pub` | — | Publisher RBAC group |

**DNS records (manual):**
- `ai-apps.env.fidoo.cloud` → CNAME to SWA default hostname (static apps)
- `*.api.env.fidoo.cloud` → CNAME to Container Environment default domain (container apps, wildcard TLS cert required)

**Key Vault secrets** (4 secrets in `kv-fidoo-vibe-deploy2`):
| Secret Name | Maps to Config |
|-------------|---------------|
| `deploy-storage-key` | `config.storageKey` |
| `deploy-acr-admin-password` | `config.acrAdminPassword` |
| `deploy-portal-client-secret` | `config.portalClientSecret` |
| `deploy-graph-sp-client-secret` | `config.graphSpClientSecret` |

**Key Vault access:** RBAC model. `fi-aiapps-pub` group needs **Key Vault Secrets User** role on the vault. Admins need **Key Vault Secrets Officer** (or Editor) to manage secrets.

**`PORTAL_CLIENT_SECRET`** is printed once during setup. Store it in a vault immediately. It is saved automatically as a SWA app setting by the script, but is not written to `infra/.env`. To rotate it:

```bash
az ad app credential reset --id <DEPLOY_PORTAL_APP_ID> --display-name swa-auth --years 2
# Then re-run setup.sh to push the new secret to SWA app settings
```

**Admin consent:** The `az ad app permission admin-consent` step requires Global Administrator or Privileged Role Administrator. If it fails, grant consent manually in the Azure Portal: **Entra ID** > **App registrations** > **Deploy Plugin** > **API permissions** > **Grant admin consent**. Azure Service Management, Azure Storage, and Azure Key Vault `user_impersonation` permissions must all be consented.

**Key Vault API permission:** If using `DEPLOY_AGENT_KEY_VAULT_NAME` for runtime secret resolution, the Deploy Plugin app registration must have the **Azure Key Vault > user_impersonation** delegated permission added and admin-consented. Without it, `auth_poll` fails with `AADSTS65001`. Add it manually: **App registrations** > **Deploy Plugin** > **API permissions** > **Add a permission** > **Azure Key Vault** > Delegated > `user_impersonation` > **Grant admin consent**.

### Infrastructure as Code Gaps

The following resources were created manually and are **not** covered by `setup.sh`:

| Resource | What's missing |
|----------|---------------|
| Key Vault (`kv-fidoo-vibe-deploy2`) | Creation, secret seeding, RBAC role assignments |
| Container Environment custom domain | Wildcard TLS cert (`*.api.env.fidoo.cloud`) + DNS suffix configuration |
| Container resource group (`rg-alipowski-test`) | Separate from `rg-published-apps` — not created by setup.sh |
| Storage account key → Key Vault | Manual secret rotation; no automation to sync rotated keys to KV |
| Deploy Plugin KV API permission | `Azure Key Vault > user_impersonation` must be added + admin-consented manually |

**Known security/permission pitfalls** (learned the hard way):

| Issue | Symptom | Fix |
|-------|---------|-----|
| Missing KV API permission on Deploy Plugin app | `auth_poll` fails with `AADSTS65001` (consent error) | Add `Azure Key Vault > user_impersonation` delegated permission + admin consent on Deploy Plugin app registration |
| Key Vault access model mismatch | 403 on secret fetch | Vault must use **RBAC** access model (not access policy), with `Key Vault Secrets User` role for `fi-aiapps-pub` |
| Missing `storageKey` in config | `AuthorizationPermissionMismatch` (403) on blob operations | Blob auth falls back from Shared Key to Bearer token, which requires `Storage Blob Data Contributor` RBAC. Either provide the storage key (via KV or env) or assign the RBAC role. |
| ARM `openIdIssuer` field name | Easy Auth silently defaults to `/common/` tenant (multi-tenant) | Field is `openIdIssuer`, NOT `openIdIssuerUrl` — the wrong name is silently ignored |
| ARM GET redacts secrets | PATCH sends null values, breaking Easy Auth config | Never read-modify-write auth settings from ARM GET; always re-send all secret values from config |
| ACR Tasks require Contributor | `AcrPush` role insufficient for `scheduleRun` / `listBuildSourceUploadUrl` | Grant `Contributor` on ACR (not just `AcrPush`) to `fi-aiapps-pub` |
| Container App creation needs RG-level Contributor | Contributor on Environment resource alone fails | Grant `Contributor` on the entire container resource group |
| Managed identity has zero role assignments | ACR pull fails at Container App startup | Run `grant-container-permissions.sh` to assign `AcrPull` on ACR to the pull identity |

To fully automate, `setup.sh` should be extended to:
1. Create the Key Vault with RBAC access model
2. Seed the 4 secrets from existing resources
3. Assign `Key Vault Secrets User` to `fi-aiapps-pub`
4. Add Key Vault API permission to Deploy Plugin app registration
5. Configure Container Environment custom domain + wildcard cert

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
| `auth_poll` | Poll for token after browser login (acquires ARM + Storage + Vault tokens) |
| `app_deploy` | Deploy a static app (first deploy or update) |
| `app_delete` | Remove a static app and redeploy site |
| `app_list` | List all deployed apps (static + container) |
| `app_info` | Get app details (URL, metadata) |
| `app_update_info` | Change app name/description without redeploying code |
| `container_deploy` | Deploy a container app (builds via ACR Tasks, configures Easy Auth) |
| `container_delete` | Remove a container app, its images, and Easy Auth redirect URI |

## Development

```bash
npm install        # Install devDependencies (typescript, @types/node)
npm run build      # Compile TypeScript to dist/
npm run dev        # Watch mode
npm test           # Run tests (requires build first)
```
