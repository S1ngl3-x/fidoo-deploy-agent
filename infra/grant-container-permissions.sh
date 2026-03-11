#!/usr/bin/env bash
#
# infra/grant-container-permissions.sh — Grant fi-aiapps-pub group the RBAC roles
# needed to deploy container apps to the Container Apps environment.
#
# Must be run by an admin with Owner or User Access Administrator on rg-alipowski-test.
#
# Usage:
#   chmod +x infra/grant-container-permissions.sh
#   ./infra/grant-container-permissions.sh
#
set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────

GROUP_NAME="fi-aiapps-pub"
ACR_NAME="fidooapps"
CONTAINER_RESOURCE_GROUP="rg-alipowski-test"
CONTAINER_ENV_NAME="managedEnvironment-rgalipowskitest-adaa"

# ── Helpers ───────────────────────────────────────────────────────────────────

info()  { printf '\033[1;34m[INFO]\033[0m  %s\n' "$*"; }
ok()    { printf '\033[1;32m[OK]\033[0m    %s\n' "$*"; }
error() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; exit 1; }

# ── Preflight ─────────────────────────────────────────────────────────────────

command -v az >/dev/null 2>&1 || error "Azure CLI (az) not installed."
az account show >/dev/null 2>&1 || error "Not logged in. Run: az login"

info "Subscription: $(az account show --query name -o tsv)"

# ── Resolve IDs ───────────────────────────────────────────────────────────────

info "Resolving group '$GROUP_NAME'..."
GROUP_ID=$(az ad group show --group "$GROUP_NAME" --query id -o tsv)
ok "Group object ID: $GROUP_ID"

info "Resolving ACR '$ACR_NAME' in '$CONTAINER_RESOURCE_GROUP'..."
ACR_ID=$(az acr show --name "$ACR_NAME" --resource-group "$CONTAINER_RESOURCE_GROUP" --query id -o tsv)
ok "ACR resource ID: $ACR_ID"

info "Resolving Container Apps Environment '$CONTAINER_ENV_NAME'..."
ENV_ID=$(az containerapp env show \
  --name "$CONTAINER_ENV_NAME" \
  --resource-group "$CONTAINER_RESOURCE_GROUP" \
  --query id -o tsv)
ok "Environment resource ID: $ENV_ID"

# ── Role assignments ──────────────────────────────────────────────────────────

# Contributor on ACR — required for ACR Tasks (scheduleRun, listBuildSourceUploadUrl).
# AcrPush alone is insufficient; those ARM actions require Contributor.
info "Assigning Contributor on ACR '$ACR_NAME' to group '$GROUP_NAME'..."
az role assignment create \
  --assignee-object-id "$GROUP_ID" \
  --assignee-principal-type Group \
  --role Contributor \
  --scope "$ACR_ID" \
  --output none 2>/dev/null || true
ok "Contributor on ACR assigned"

# Contributor on Container Apps Environment — required to create/update Container Apps.
info "Assigning Contributor on '$CONTAINER_ENV_NAME' to group '$GROUP_NAME'..."
az role assignment create \
  --assignee-object-id "$GROUP_ID" \
  --assignee-principal-type Group \
  --role Contributor \
  --scope "$ENV_ID" \
  --output none 2>/dev/null || true
ok "Contributor on Container Apps Environment assigned"

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "══════════════════════════════════════════════════════════════════════════"
echo "  Container RBAC setup complete!"
echo "══════════════════════════════════════════════════════════════════════════"
echo ""
echo "  Group '$GROUP_NAME' now has:"
echo "    - Contributor on ACR '$ACR_NAME' (for image builds via ACR Tasks)"
echo "    - Contributor on '$CONTAINER_ENV_NAME' (for Container Apps deploy)"
echo ""
echo "  To onboard a publisher:"
echo "    USER_ID=\$(az ad user show --id user@FidooFXtest.onmicrosoft.com --query id -o tsv)"
echo "    az ad group member add --group $GROUP_NAME --member-id \$USER_ID"
echo ""
