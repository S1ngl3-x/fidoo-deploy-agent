#!/usr/bin/env bash
#
# infra/setup.sh — Idempotent Azure infrastructure setup for Deploy Agent
#
# Creates: resource group, Deploy Plugin app registration, Storage Account,
#          single Static Web App, RBAC.
# Safe to re-run — checks resource existence before creating.
#
# Prerequisites:
#   - Azure CLI (`az`) installed and logged in with admin permissions
#   - Sufficient permissions: create app registrations, assign roles,
#     create SWAs, create Storage Accounts
#
# Usage:
#   chmod +x infra/setup.sh
#   ./infra/setup.sh
#
set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────

LOCATION="westeurope"
RESOURCE_GROUP="rg-published-apps"
DEPLOY_PLUGIN_APP_NAME="Deploy Plugin"
DEPLOY_PORTAL_APP_NAME="Deploy Portal"
SWA_SLUG="ai-apps"                        # Single SWA resource name
SWA_NAME="swa-${SWA_SLUG}"
STORAGE_ACCOUNT="stpublishedapps"          # Must be globally unique, 3-24 lowercase alphanumeric
CONTAINER_NAME="app-content"               # Blob container for app files + registry
APP_DOMAIN="ai-apps.env.fidoo.cloud"       # Custom domain (DNS configured manually)
ACR_NAME="fidooapps"
CONTAINER_ENV_NAME="fidoo-vibe-env"
PULL_IDENTITY_NAME="fidoo-vibe-container-puller"
CONTAINER_DOMAIN="api.env.fidoo.cloud"

# ── Helpers ───────────────────────────────────────────────────────────────────

info()  { printf '\033[1;34m[INFO]\033[0m  %s\n' "$*"; }
ok()    { printf '\033[1;32m[OK]\033[0m    %s\n' "$*"; }
warn()  { printf '\033[1;33m[WARN]\033[0m  %s\n' "$*"; }
error() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; exit 1; }

# ── Pre-flight checks ────────────────────────────────────────────────────────

info "Running pre-flight checks..."

command -v az >/dev/null 2>&1 || error "Azure CLI (az) is not installed. Install from https://aka.ms/install-azure-cli"

# Check if logged in
az account show >/dev/null 2>&1 || error "Not logged in to Azure CLI. Run: az login"

TENANT_ID=$(az account show --query tenantId -o tsv)
SUBSCRIPTION_ID=$(az account show --query id -o tsv)
SUBSCRIPTION_NAME=$(az account show --query name -o tsv)

info "Tenant:       $TENANT_ID"
info "Subscription: $SUBSCRIPTION_NAME ($SUBSCRIPTION_ID)"

# ── 1. Resource Group ─────────────────────────────────────────────────────────

info "Checking resource group '$RESOURCE_GROUP'..."

if az group show --name "$RESOURCE_GROUP" >/dev/null 2>&1; then
  ok "Resource group '$RESOURCE_GROUP' already exists"
else
  info "Creating resource group '$RESOURCE_GROUP' in $LOCATION..."
  az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none
  ok "Resource group '$RESOURCE_GROUP' created"
fi

# ── 2. App Registration: Deploy Plugin ────────────────────────────────────────

info "Checking app registration '$DEPLOY_PLUGIN_APP_NAME'..."

DEPLOY_PLUGIN_APP_ID=$(az ad app list --display-name "$DEPLOY_PLUGIN_APP_NAME" --query "[0].appId" -o tsv 2>/dev/null || true)

if [[ -n "$DEPLOY_PLUGIN_APP_ID" && "$DEPLOY_PLUGIN_APP_ID" != "None" ]]; then
  ok "App registration '$DEPLOY_PLUGIN_APP_NAME' already exists (appId: $DEPLOY_PLUGIN_APP_ID)"
else
  info "Creating app registration '$DEPLOY_PLUGIN_APP_NAME'..."
  DEPLOY_PLUGIN_APP_ID=$(az ad app create \
    --display-name "$DEPLOY_PLUGIN_APP_NAME" \
    --sign-in-audience "AzureADMyOrg" \
    --is-fallback-public-client true \
    --query appId -o tsv)
  ok "App registration '$DEPLOY_PLUGIN_APP_NAME' created (appId: $DEPLOY_PLUGIN_APP_ID)"
fi

# Enable public client flow (idempotent)
info "Ensuring public client flow is enabled..."
az ad app update --id "$DEPLOY_PLUGIN_APP_ID" --is-fallback-public-client true 2>/dev/null
ok "Public client flow enabled"

# Add API permission: Azure Service Management / user_impersonation
# Resource App ID for Azure Service Management: 797f4846-ba00-4fd7-ba43-dac1f8f63013
# Permission ID for user_impersonation: 41094075-9dad-400e-a0bd-54e686782033
info "Adding API permission (Azure Service Management / user_impersonation)..."
az ad app permission add \
  --id "$DEPLOY_PLUGIN_APP_ID" \
  --api "797f4846-ba00-4fd7-ba43-dac1f8f63013" \
  --api-permissions "41094075-9dad-400e-a0bd-54e686782033=Scope" 2>/dev/null || true
ok "ARM API permission configured"

# Add API permission: Azure Storage / user_impersonation
# Resource App ID for Azure Storage: e406a681-f3d4-42a8-90b6-c2b029497af1
# Permission ID for user_impersonation: 03e0da56-190b-40ad-a80c-ea378c433f7f
info "Adding API permission (Azure Storage / user_impersonation)..."
az ad app permission add \
  --id "$DEPLOY_PLUGIN_APP_ID" \
  --api "e406a681-f3d4-42a8-90b6-c2b029497af1" \
  --api-permissions "03e0da56-190b-40ad-a80c-ea378c433f7f=Scope" 2>/dev/null || true
ok "Storage API permission configured"

# Grant admin consent for all configured API permissions
info "Granting admin consent for API permissions..."
az ad app permission admin-consent --id "$DEPLOY_PLUGIN_APP_ID" 2>/dev/null || true
ok "Admin consent granted"

# Create app_publisher app role (idempotent — check if it exists first)
info "Checking app_publisher role..."
EXISTING_ROLES=$(az ad app show --id "$DEPLOY_PLUGIN_APP_ID" --query "appRoles[?value=='app_publisher'].id" -o tsv 2>/dev/null || true)

if [[ -n "$EXISTING_ROLES" ]]; then
  ok "app_publisher role already exists"
else
  info "Creating app_publisher role..."
  APP_ROLE_ID=$(uuidgen 2>/dev/null || python3 -c "import uuid; print(uuid.uuid4())")
  az ad app update --id "$DEPLOY_PLUGIN_APP_ID" --app-roles "[
    {
      \"allowedMemberTypes\": [\"User\"],
      \"description\": \"Can deploy and manage static web apps\",
      \"displayName\": \"App Publisher\",
      \"isEnabled\": true,
      \"value\": \"app_publisher\",
      \"id\": \"$APP_ROLE_ID\"
    }
  ]" 2>/dev/null
  ok "app_publisher role created"
fi

# ── 2b. App Registration: Deploy Portal ──────────────────────────────────────
# Single-tenant web app used by SWA authsettingsV2 for portal visitors.
# Separate from Deploy Plugin (used for MCP agent OAuth).

info "Checking app registration '$DEPLOY_PORTAL_APP_NAME'..."
DEPLOY_PORTAL_APP_ID=$(az ad app list \
  --display-name "$DEPLOY_PORTAL_APP_NAME" \
  --query "[0].appId" -o tsv 2>/dev/null || true)

if [[ -n "$DEPLOY_PORTAL_APP_ID" && "$DEPLOY_PORTAL_APP_ID" != "None" ]]; then
  ok "App registration '$DEPLOY_PORTAL_APP_NAME' already exists (appId: $DEPLOY_PORTAL_APP_ID)"
else
  info "Creating app registration '$DEPLOY_PORTAL_APP_NAME'..."
  DEPLOY_PORTAL_APP_ID=$(az ad app create \
    --display-name "$DEPLOY_PORTAL_APP_NAME" \
    --sign-in-audience "AzureADMyOrg" \
    --query appId -o tsv)
  ok "App registration '$DEPLOY_PORTAL_APP_NAME' created (appId: $DEPLOY_PORTAL_APP_ID)"
fi

# Redirect URIs required by SWA auth service (identity.2.azurestaticapps.net)
info "Configuring redirect URIs and ID token issuance for '$DEPLOY_PORTAL_APP_NAME'..."
az ad app update \
  --id "$DEPLOY_PORTAL_APP_ID" \
  --web-redirect-uris \
    "https://${APP_DOMAIN}/.auth/login/aad/callback" \
    "https://delightful-flower-02f85aa03.2.azurestaticapps.net/.auth/login/aad/callback" \
  --enable-id-token-issuance true \
  2>/dev/null || true
ok "Redirect URIs and ID token issuance configured"

# Create service principal (required for token issuance)
info "Checking service principal for '$DEPLOY_PORTAL_APP_NAME'..."
DEPLOY_PORTAL_SP_ID=$(az ad sp list \
  --filter "appId eq '$DEPLOY_PORTAL_APP_ID'" \
  --query "[0].id" -o tsv 2>/dev/null || true)
if [[ -z "$DEPLOY_PORTAL_SP_ID" || "$DEPLOY_PORTAL_SP_ID" == "None" ]]; then
  DEPLOY_PORTAL_SP_ID=$(az ad sp create --id "$DEPLOY_PORTAL_APP_ID" --query id -o tsv)
  ok "Service principal created (objectId: $DEPLOY_PORTAL_SP_ID)"
else
  ok "Service principal already exists (objectId: $DEPLOY_PORTAL_SP_ID)"
fi

# Client secret — skip if one already exists (rotate manually when needed)
info "Checking client secret for '$DEPLOY_PORTAL_APP_NAME'..."
EXISTING_SECRET_COUNT=$(az ad app credential list \
  --id "$DEPLOY_PORTAL_APP_ID" \
  --query "length(@)" -o tsv 2>/dev/null || echo "0")

if [[ "${EXISTING_SECRET_COUNT}" -gt "0" ]]; then
  warn "Client secret already exists — skipping creation."
  warn "To rotate: delete via portal/CLI and re-run setup.sh, then re-run section 5b."
  DEPLOY_PORTAL_CLIENT_SECRET="ROTATE_MANUALLY"
else
  DEPLOY_PORTAL_CLIENT_SECRET=$(az ad app credential reset \
    --id "$DEPLOY_PORTAL_APP_ID" \
    --display-name "swa-auth" \
    --years 2 \
    --query password -o tsv)
  ok "Client secret created (shown once below — store securely)"
  echo "  PORTAL_CLIENT_SECRET=${DEPLOY_PORTAL_CLIENT_SECRET}"
fi

# ── 2c. App Registration: Graph SP (for Easy Auth redirect URI management) ───
# Dedicated SP with Application.ReadWrite.OwnedBy — can only modify apps it owns.
# Used by deploy agent to add/remove redirect URIs on the Deploy Portal app.

GRAPH_SP_APP_NAME="Deploy Agent Graph SP"

info "Checking app registration '$GRAPH_SP_APP_NAME'..."
GRAPH_SP_APP_ID=$(az ad app list \
  --display-name "$GRAPH_SP_APP_NAME" \
  --query "[0].appId" -o tsv 2>/dev/null || true)

if [[ -n "$GRAPH_SP_APP_ID" && "$GRAPH_SP_APP_ID" != "None" ]]; then
  ok "App registration '$GRAPH_SP_APP_NAME' already exists (appId: $GRAPH_SP_APP_ID)"
else
  info "Creating app registration '$GRAPH_SP_APP_NAME'..."
  GRAPH_SP_APP_ID=$(az ad app create \
    --display-name "$GRAPH_SP_APP_NAME" \
    --sign-in-audience "AzureADMyOrg" \
    --query appId -o tsv)
  ok "App registration '$GRAPH_SP_APP_NAME' created (appId: $GRAPH_SP_APP_ID)"
fi

# Create service principal for Graph SP
info "Checking service principal for '$GRAPH_SP_APP_NAME'..."
GRAPH_SP_OBJECT_ID=$(az ad sp list \
  --filter "appId eq '$GRAPH_SP_APP_ID'" \
  --query "[0].id" -o tsv 2>/dev/null || true)
if [[ -z "$GRAPH_SP_OBJECT_ID" || "$GRAPH_SP_OBJECT_ID" == "None" ]]; then
  GRAPH_SP_OBJECT_ID=$(az ad sp create --id "$GRAPH_SP_APP_ID" --query id -o tsv)
  ok "Service principal created (objectId: $GRAPH_SP_OBJECT_ID)"
else
  ok "Service principal already exists (objectId: $GRAPH_SP_OBJECT_ID)"
fi

# Grant Application.ReadWrite.OwnedBy on Microsoft Graph
# 18a4783c-866b-4cc7-a460-3d5e5662c884 = Application.ReadWrite.OwnedBy
info "Adding Application.ReadWrite.OwnedBy permission to Graph SP..."
az ad app permission add \
  --id "$GRAPH_SP_APP_ID" \
  --api 00000003-0000-0000-c000-000000000000 \
  --api-permissions 18a4783c-866b-4cc7-a460-3d5e5662c884=Role 2>/dev/null || true

az ad app permission admin-consent --id "$GRAPH_SP_APP_ID" 2>/dev/null || true
ok "Application.ReadWrite.OwnedBy granted and admin-consented"

# Add Graph SP as owner of Deploy Portal app (so OwnedBy scope works)
PORTAL_OBJECT_ID=$(az ad app show --id "$DEPLOY_PORTAL_APP_ID" --query id -o tsv)
info "Adding Graph SP as owner of Deploy Portal app..."
az ad app owner add --id "$PORTAL_OBJECT_ID" --owner-object-id "$GRAPH_SP_OBJECT_ID" 2>/dev/null || true
ok "Graph SP is owner of Deploy Portal app"

# Client secret for Graph SP — skip if one already exists
info "Checking client secret for '$GRAPH_SP_APP_NAME'..."
GRAPH_SP_SECRET_COUNT=$(az ad app credential list \
  --id "$GRAPH_SP_APP_ID" \
  --query "length(@)" -o tsv 2>/dev/null || echo "0")

if [[ "${GRAPH_SP_SECRET_COUNT}" -gt "0" ]]; then
  warn "Graph SP client secret already exists — skipping creation."
  GRAPH_SP_CLIENT_SECRET="ROTATE_MANUALLY"
else
  GRAPH_SP_CLIENT_SECRET=$(az ad app credential reset \
    --id "$GRAPH_SP_APP_ID" \
    --display-name "easy-auth" \
    --years 2 \
    --query password -o tsv)
  ok "Graph SP client secret created (shown once below — store securely)"
  echo "  GRAPH_SP_CLIENT_SECRET=${GRAPH_SP_CLIENT_SECRET}"
fi

# ── 3. Storage Account ───────────────────────────────────────────────────────

info "Checking storage account '$STORAGE_ACCOUNT'..."

if az storage account show --name "$STORAGE_ACCOUNT" --resource-group "$RESOURCE_GROUP" >/dev/null 2>&1; then
  ok "Storage account '$STORAGE_ACCOUNT' already exists"
else
  info "Creating storage account '$STORAGE_ACCOUNT'..."
  az storage account create \
    --name "$STORAGE_ACCOUNT" \
    --resource-group "$RESOURCE_GROUP" \
    --location "$LOCATION" \
    --sku Standard_LRS \
    --kind StorageV2 \
    --output none
  ok "Storage account '$STORAGE_ACCOUNT' created"
fi

# Create blob container (idempotent)
info "Checking blob container '$CONTAINER_NAME'..."
CONTAINER_EXISTS=$(az storage container exists \
  --name "$CONTAINER_NAME" \
  --account-name "$STORAGE_ACCOUNT" \
  --auth-mode login \
  --query exists -o tsv 2>/dev/null || echo "false")

if [[ "$CONTAINER_EXISTS" == "true" ]]; then
  ok "Blob container '$CONTAINER_NAME' already exists"
else
  info "Creating blob container '$CONTAINER_NAME'..."
  az storage container create \
    --name "$CONTAINER_NAME" \
    --account-name "$STORAGE_ACCOUNT" \
    --auth-mode login \
    --output none
  ok "Blob container '$CONTAINER_NAME' created"
fi

# ── 3b. Azure Container Registry ─────────────────────────────────────────────

info "Checking Azure Container Registry '$ACR_NAME'..."

if az acr show --name "$ACR_NAME" --resource-group "$RESOURCE_GROUP" >/dev/null 2>&1; then
  ok "ACR '$ACR_NAME' already exists"
else
  info "Creating ACR '$ACR_NAME' (Basic SKU)..."
  az acr create \
    --name "$ACR_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --sku Basic \
    --location "$LOCATION" \
    --output none
  ok "ACR '$ACR_NAME' created"
fi

ACR_ID=$(az acr show --name "$ACR_NAME" --resource-group "$RESOURCE_GROUP" --query id -o tsv)
ACR_LOGIN_SERVER=$(az acr show --name "$ACR_NAME" --query loginServer -o tsv)

# ── 3c. Container Apps Environment ───────────────────────────────────────────

info "Checking Container Apps Environment '$CONTAINER_ENV_NAME'..."

if az containerapp env show --name "$CONTAINER_ENV_NAME" --resource-group "$RESOURCE_GROUP" >/dev/null 2>&1; then
  ok "Container Apps Environment '$CONTAINER_ENV_NAME' already exists"
else
  info "Creating Container Apps Environment '$CONTAINER_ENV_NAME'..."
  az containerapp env create \
    --name "$CONTAINER_ENV_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --location "$LOCATION" \
    --output none
  ok "Container Apps Environment '$CONTAINER_ENV_NAME' created"
fi

CONTAINER_ENV_ID=$(az containerapp env show --name "$CONTAINER_ENV_NAME" --resource-group "$RESOURCE_GROUP" --query id -o tsv)

# ── 3d. Container Apps Environment custom domain (manual) ───────────────────
# Easy Auth requires each container app to have a custom domain like:
#   https://{slug}.api.env.fidoo.cloud
# This needs a wildcard DNS record and TLS cert set up once on the Environment.

info "Container Apps Environment custom domain setup:"
echo "  Manual steps required (one-time):"
echo "    1. Obtain wildcard TLS cert for *.${CONTAINER_DOMAIN} (PFX format)"
echo "    2. Add DNS record: *.api CNAME \$(az containerapp env show --name $CONTAINER_ENV_NAME --resource-group $RESOURCE_GROUP --query 'properties.defaultDomain' -o tsv)"
echo "    3. Then run:"
echo "       az containerapp env update \\"
echo "         --name $CONTAINER_ENV_NAME \\"
echo "         --resource-group $RESOURCE_GROUP \\"
echo "         --custom-domain-dnssuffix ${CONTAINER_DOMAIN} \\"
echo "         --custom-domain-certificate-file ./wildcard-api-cert.pfx \\"
echo "         --custom-domain-certificate-password \"\""

# ── 4. Single Static Web App ─────────────────────────────────────────────────

info "Checking SWA '$SWA_NAME'..."

if az staticwebapp show --name "$SWA_NAME" --resource-group "$RESOURCE_GROUP" >/dev/null 2>&1; then
  ok "SWA '$SWA_NAME' already exists"
else
  info "Creating SWA '$SWA_NAME'..."
  az staticwebapp create \
    --name "$SWA_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --location "$LOCATION" \
    --sku Free \
    --output none
  ok "SWA '$SWA_NAME' created"
fi

# ── 5. Service Principal ─────────────────────────────────────────────────────
# Needed for admin-consent grant. RBAC roles go on the security group below,
# not on the SP — the plugin uses delegated (user) tokens via device code flow.

info "Checking service principal for '$DEPLOY_PLUGIN_APP_NAME'..."
DEPLOY_PLUGIN_SP_ID=$(az ad sp list --filter "appId eq '$DEPLOY_PLUGIN_APP_ID'" --query "[0].id" -o tsv 2>/dev/null || true)

if [[ -z "$DEPLOY_PLUGIN_SP_ID" || "$DEPLOY_PLUGIN_SP_ID" == "None" ]]; then
  info "Creating service principal..."
  DEPLOY_PLUGIN_SP_ID=$(az ad sp create --id "$DEPLOY_PLUGIN_APP_ID" --query id -o tsv)
  ok "Service principal created (objectId: $DEPLOY_PLUGIN_SP_ID)"
else
  ok "Service principal already exists (objectId: $DEPLOY_PLUGIN_SP_ID)"
fi

# ── 5b. SWA Application Settings ─────────────────────────────────────────────
# PORTAL_CLIENT_ID / PORTAL_CLIENT_SECRET are read by authsettingsV2 at runtime.
# Never embedded in deployed content.

info "Setting SWA application settings..."
if [[ "$DEPLOY_PORTAL_CLIENT_SECRET" == "ROTATE_MANUALLY" ]]; then
  warn "Skipping app settings — secret not available. Set manually:"
  warn "  az staticwebapp appsettings set --name $SWA_NAME --resource-group $RESOURCE_GROUP \\"
  warn "    --setting-names PORTAL_CLIENT_ID=$DEPLOY_PORTAL_APP_ID PORTAL_CLIENT_SECRET=<secret>"
else
  az staticwebapp appsettings set \
    --name "$SWA_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --setting-names \
      "PORTAL_CLIENT_ID=${DEPLOY_PORTAL_APP_ID}" \
      "PORTAL_CLIENT_SECRET=${DEPLOY_PORTAL_CLIENT_SECRET}" \
    --output none
  ok "SWA app settings configured: PORTAL_CLIENT_ID, PORTAL_CLIENT_SECRET"
fi

# ── 5c. SWA Authentication Configuration ─────────────────────────────────────
# NOTE: Azure Static Web Apps does NOT support ARM authsettingsV2 (that endpoint
# is App Service only). SWA auth is configured via the "auth" block in
# staticwebapp.config.json, which is generated and deployed by the plugin's
# assemble.ts on every site deploy. The config references PORTAL_CLIENT_ID and
# PORTAL_CLIENT_SECRET app settings (set in 5b above) to use the custom
# "Deploy Portal" AAD app instead of the global Microsoft SWA enterprise app.
# No ARM action needed here — running "app_deploy" will apply the auth config.
ok "SWA auth config is embedded in staticwebapp.config.json (deployed by the plugin)"

# ── 6. Security Group & RBAC ───────────────────────────────────────────────

GROUP_NAME="fi-aiapps-pub"

info "Checking security group '$GROUP_NAME'..."
GROUP_ID=$(az ad group list --display-name "$GROUP_NAME" --query "[0].id" -o tsv 2>/dev/null || true)

if [[ -n "$GROUP_ID" && "$GROUP_ID" != "None" ]]; then
  ok "Security group '$GROUP_NAME' already exists (objectId: $GROUP_ID)"
else
  info "Creating security group '$GROUP_NAME'..."
  GROUP_ID=$(az ad group create \
    --display-name "$GROUP_NAME" \
    --mail-nickname "$GROUP_NAME" \
    --query id -o tsv)
  ok "Security group '$GROUP_NAME' created (objectId: $GROUP_ID)"
fi

# Assign Storage Blob Data Contributor on the storage account to the group
STORAGE_ID=$(az storage account show --name "$STORAGE_ACCOUNT" --resource-group "$RESOURCE_GROUP" --query id -o tsv)

info "Assigning Storage Blob Data Contributor on '$STORAGE_ACCOUNT' to group '$GROUP_NAME'..."
az role assignment create \
  --assignee-object-id "$GROUP_ID" \
  --assignee-principal-type Group \
  --role "Storage Blob Data Contributor" \
  --scope "$STORAGE_ID" \
  --output none 2>/dev/null || true
ok "Storage Blob Data Contributor role assigned to group"

# Assign Contributor on the SWA to the group
SWA_ID=$(az staticwebapp show --name "$SWA_NAME" --resource-group "$RESOURCE_GROUP" --query id -o tsv)

info "Assigning Contributor on '$SWA_NAME' to group '$GROUP_NAME'..."
az role assignment create \
  --assignee-object-id "$GROUP_ID" \
  --assignee-principal-type Group \
  --role "Contributor" \
  --scope "$SWA_ID" \
  --output none 2>/dev/null || true
ok "Contributor role assigned to group"

# ── 6b. Container RBAC ────────────────────────────────────────────────────────
# ⚠️  REQUIRES OWNER OR USER ACCESS ADMINISTRATOR
# If you only have Contributor, ask your Azure admin to run this section.
# Regular users DO NOT need Owner — this runs once per environment, not per deploy.

info "Checking pull identity '$PULL_IDENTITY_NAME'..."
PULL_IDENTITY_CLIENT_ID=$(az identity show \
  --name "$PULL_IDENTITY_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --query clientId -o tsv 2>/dev/null || true)
PULL_IDENTITY_ID=$(az identity show \
  --name "$PULL_IDENTITY_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --query id -o tsv 2>/dev/null || true)

if [[ -n "$PULL_IDENTITY_CLIENT_ID" && "$PULL_IDENTITY_CLIENT_ID" != "None" ]]; then
  ok "Pull identity '$PULL_IDENTITY_NAME' already exists"
else
  info "Creating pull identity '$PULL_IDENTITY_NAME'..."
  PULL_IDENTITY_CLIENT_ID=$(az identity create \
    --name "$PULL_IDENTITY_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --query clientId -o tsv)
  PULL_IDENTITY_ID=$(az identity show \
    --name "$PULL_IDENTITY_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --query id -o tsv)
  ok "Pull identity created (clientId: $PULL_IDENTITY_CLIENT_ID)"
fi

# AcrPull on ACR for the pull identity — lets Container Apps pull images
info "Assigning AcrPull on '$ACR_NAME' to pull identity..."
az role assignment create \
  --assignee "$PULL_IDENTITY_CLIENT_ID" \
  --role "AcrPull" \
  --scope "$ACR_ID" \
  --output none 2>/dev/null || true
ok "AcrPull assigned to pull identity"

# AcrPush on ACR for publisher group — lets users trigger builds
info "Assigning AcrPush on '$ACR_NAME' to group '$GROUP_NAME'..."
az role assignment create \
  --assignee-object-id "$GROUP_ID" \
  --assignee-principal-type Group \
  --role "AcrPush" \
  --scope "$ACR_ID" \
  --output none 2>/dev/null || true
ok "AcrPush assigned to group"

# Contributor on Container Apps Environment for publisher group — lets users create/update apps
info "Assigning Contributor on '$CONTAINER_ENV_NAME' to group '$GROUP_NAME'..."
az role assignment create \
  --assignee-object-id "$GROUP_ID" \
  --assignee-principal-type Group \
  --role "Contributor" \
  --scope "$CONTAINER_ENV_ID" \
  --output none 2>/dev/null || true
ok "Contributor on Container Apps Environment assigned to group"
# ── END REQUIRES OWNER ────────────────────────────────────────────────────────

# ── 7. Write infra/.env ──────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

info "Writing config to $ENV_FILE..."
cat > "$ENV_FILE" <<EOF
# Deploy Agent configuration — generated by infra/setup.sh
# Source this file or set these environment variables before running the plugin.
#
# Usage: source infra/.env

DEPLOY_AGENT_TENANT_ID=$TENANT_ID
DEPLOY_AGENT_CLIENT_ID=$DEPLOY_PLUGIN_APP_ID
DEPLOY_AGENT_SUBSCRIPTION_ID=$SUBSCRIPTION_ID
DEPLOY_AGENT_RESOURCE_GROUP=$RESOURCE_GROUP
DEPLOY_AGENT_STORAGE_ACCOUNT=$STORAGE_ACCOUNT
DEPLOY_AGENT_CONTAINER_NAME=$CONTAINER_NAME
DEPLOY_AGENT_APP_DOMAIN=$APP_DOMAIN
DEPLOY_AGENT_SWA_SLUG=$SWA_SLUG
DEPLOY_PORTAL_CLIENT_ID=$DEPLOY_PORTAL_APP_ID
DEPLOY_AGENT_ACR_NAME=$ACR_NAME
DEPLOY_AGENT_ACR_LOGIN_SERVER=$ACR_LOGIN_SERVER
DEPLOY_AGENT_CONTAINER_ENV_NAME=$CONTAINER_ENV_NAME
DEPLOY_AGENT_CONTAINER_DOMAIN=$CONTAINER_DOMAIN
DEPLOY_AGENT_PULL_IDENTITY_ID=$PULL_IDENTITY_ID
DEPLOY_AGENT_DEFAULT_PORT=8080
DEPLOY_AGENT_PORTAL_CLIENT_ID=$DEPLOY_PORTAL_APP_ID
DEPLOY_AGENT_PORTAL_OBJECT_ID=$PORTAL_OBJECT_ID
DEPLOY_AGENT_GRAPH_SP_CLIENT_ID=$GRAPH_SP_APP_ID
EOF

ok "Config written to $ENV_FILE"

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "══════════════════════════════════════════════════════════════════════════"
echo "  Infrastructure setup complete!"
echo "══════════════════════════════════════════════════════════════════════════"
echo ""
echo "  Config values (also written to infra/.env):"
echo ""
echo "    DEPLOY_AGENT_TENANT_ID=$TENANT_ID"
echo "    DEPLOY_AGENT_CLIENT_ID=$DEPLOY_PLUGIN_APP_ID"
echo "    DEPLOY_AGENT_SUBSCRIPTION_ID=$SUBSCRIPTION_ID"
echo "    DEPLOY_AGENT_RESOURCE_GROUP=$RESOURCE_GROUP"
echo "    DEPLOY_AGENT_STORAGE_ACCOUNT=$STORAGE_ACCOUNT"
echo "    DEPLOY_AGENT_CONTAINER_NAME=$CONTAINER_NAME"
echo "    DEPLOY_AGENT_APP_DOMAIN=$APP_DOMAIN"
echo "    DEPLOY_AGENT_SWA_SLUG=$SWA_SLUG"
echo "    DEPLOY_PORTAL_CLIENT_ID=$DEPLOY_PORTAL_APP_ID"
echo ""
echo ""
echo "  Easy Auth (Graph SP for redirect URI management):"
echo "    DEPLOY_AGENT_PORTAL_CLIENT_ID=$DEPLOY_PORTAL_APP_ID"
echo "    DEPLOY_AGENT_PORTAL_OBJECT_ID=$PORTAL_OBJECT_ID"
echo "    DEPLOY_AGENT_GRAPH_SP_CLIENT_ID=$GRAPH_SP_APP_ID"
echo "    DEPLOY_AGENT_GRAPH_SP_CLIENT_SECRET=$GRAPH_SP_CLIENT_SECRET"
echo "    DEPLOY_AGENT_PORTAL_CLIENT_SECRET — use the Deploy Portal client secret"
echo "    Add these to your .mcp.json env block for Easy Auth to work."
echo ""
echo "  Portal auth (PORTAL_CLIENT_SECRET stored as SWA app setting — NOT in .env):"
echo "    Store PORTAL_CLIENT_SECRET in a vault. Rotate via:"
echo "    az ad app credential reset --id $DEPLOY_PORTAL_APP_ID --display-name swa-auth --years 2"
echo "    Then re-run setup.sh to update the SWA app setting."
echo ""
echo "  DNS setup (manual — must be done by an admin):"
echo "    Create a CNAME record pointing '$APP_DOMAIN' to the default"
echo "    hostname of the SWA '$SWA_NAME'. Then configure the custom domain"
echo "    on the SWA in the Azure portal."
echo ""
echo "  Next steps:"
echo "    1. Source the env file:  source infra/.env"
echo "    2. Rebuild the plugin:  npm run build"
echo ""
echo "  Onboard publishers:"
echo "    az ad group member add --group $GROUP_NAME --member-id <user-object-id>"
echo ""
echo "  View apps:"
echo "    Any tenant member can view apps — Entra ID login is required."
echo ""
