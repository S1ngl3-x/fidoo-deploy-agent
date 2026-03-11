#!/usr/bin/env bash
#
# infra/cert.sh — Wildcard TLS certificate acquisition and renewal
#
# Issues or renews a wildcard cert for *.api.env.fidoo.cloud using acme.sh
# with manual DNS-01 challenge (Active24 DNS, no automation).
# Applies the resulting cert to the Azure Container Apps Environment.
#
# Usage:
#   chmod +x infra/cert.sh
#   ./infra/cert.sh setup    # First-time acquisition
#   ./infra/cert.sh renew    # Renew (skips if not yet due; use --force to override)
#   ./infra/cert.sh renew --force
#
set -euo pipefail

# ── Constants ─────────────────────────────────────────────────────────────────

DOMAIN="api.env.fidoo.cloud"
WILDCARD_DOMAIN="*.${DOMAIN}"
ACME_HOME="${HOME}/.acme.sh"
ACME="${ACME_HOME}/acme.sh"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERTS_DIR="${SCRIPT_DIR}/certs"

# ── Helpers ───────────────────────────────────────────────────────────────────

info()  { printf '\033[1;34m[INFO]\033[0m  %s\n' "$*"; }
ok()    { printf '\033[1;32m[OK]\033[0m    %s\n' "$*"; }
warn()  { printf '\033[1;33m[WARN]\033[0m  %s\n' "$*"; }
error() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; exit 1; }

# ── Usage ─────────────────────────────────────────────────────────────────────

usage() {
  echo "Usage: $0 <subcommand> [options]"
  echo ""
  echo "Subcommands:"
  echo "  setup          First-time certificate acquisition"
  echo "  renew          Renew certificate (skips if not yet due)"
  echo "  renew --force  Force renewal regardless of expiry"
  echo ""
  exit 1
}

# ── Step 1: Preflight ─────────────────────────────────────────────────────────

preflight() {
  info "Running pre-flight checks..."

  command -v az >/dev/null 2>&1 || error "Azure CLI (az) is not installed."
  command -v openssl >/dev/null 2>&1 || error "openssl is not installed."
  command -v curl >/dev/null 2>&1 || error "curl is not installed."

  az account show >/dev/null 2>&1 || error "Not logged in to Azure CLI. Run: az login"

  # Source infra/.env
  ENV_FILE="${SCRIPT_DIR}/.env"
  [[ -f "$ENV_FILE" ]] || error "infra/.env not found. Run infra/setup.sh first."
  # shellcheck source=/dev/null
  source "$ENV_FILE"

  [[ -n "${DEPLOY_AGENT_CONTAINER_ENV_NAME:-}" ]] || \
    error "DEPLOY_AGENT_CONTAINER_ENV_NAME not set in infra/.env"
  [[ -n "${DEPLOY_AGENT_CONTAINER_RESOURCE_GROUP:-}" ]] || \
    error "DEPLOY_AGENT_CONTAINER_RESOURCE_GROUP not set in infra/.env"

  CURRENT_TENANT=$(az account show --query tenantId -o tsv)
  if [[ -n "${DEPLOY_AGENT_TENANT_ID:-}" && "$CURRENT_TENANT" != "$DEPLOY_AGENT_TENANT_ID" ]]; then
    warn "Current tenant ($CURRENT_TENANT) differs from DEPLOY_AGENT_TENANT_ID ($DEPLOY_AGENT_TENANT_ID)"
    warn "Make sure you are logged in to the correct Azure tenant."
  fi

  ok "Pre-flight checks passed"
  ok "Container env:    $DEPLOY_AGENT_CONTAINER_ENV_NAME"
  ok "Resource group:   $DEPLOY_AGENT_CONTAINER_RESOURCE_GROUP"
}

# ── Step 2: Install acme.sh ───────────────────────────────────────────────────

install_acme() {
  if [[ -x "$ACME" ]]; then
    ok "acme.sh already installed at $ACME"
    return
  fi

  info "Installing acme.sh to $ACME_HOME ..."
  curl -fsSL https://get.acme.sh | sh
  ok "acme.sh installed"
}

# ── Step 3: Issue or renew cert ───────────────────────────────────────────────

issue_cert() {
  local subcommand="$1"
  local force="${2:-}"

  mkdir -p "$CERTS_DIR"

  if [[ "$subcommand" == "setup" ]]; then
    info "Issuing new certificate for ${WILDCARD_DOMAIN} (DNS-01 manual mode)..."
    info "acme.sh will print a TXT record value — add it at Active24, then press Enter."
    echo ""

    "$ACME" --issue \
      --dns \
      --domain "${WILDCARD_DOMAIN}" \
      --domain "${DOMAIN}" \
      --server letsencrypt \
      --keylength 2048 \
      --yes-I-know-dns-manual-mode-enough-go-ahead-please \
      || true
    # acme.sh exits 1 on first --issue in DNS manual mode (by design).
    # It prints the TXT challenge value and stops — we complete with --renew.

    echo ""
    warn "──────────────────────────────────────────────────────────────────────"
    warn "ACTION REQUIRED (DNS records at Active24):"
    warn ""
    warn "  1. ACME challenge (for cert issuance):"
    warn "     _acme-challenge.${DOMAIN}  TXT  <value shown above>"
    warn ""
    warn "  2. Domain ownership (for Azure custom domain suffix, one-time):"
    warn "     asuid.${DOMAIN}  TXT  $(az containerapp env show \
      --name "$DEPLOY_AGENT_CONTAINER_ENV_NAME" \
      --resource-group "$DEPLOY_AGENT_CONTAINER_RESOURCE_GROUP" \
      --query "properties.customDomainConfiguration.customDomainVerificationId" -o tsv 2>/dev/null || echo "<customDomainVerificationId from Azure portal>")"
    warn ""
    warn "  3. Wildcard CNAME (one-time):"
    warn "     *.${DOMAIN}  CNAME  $(az containerapp env show \
      --name "$DEPLOY_AGENT_CONTAINER_ENV_NAME" \
      --resource-group "$DEPLOY_AGENT_CONTAINER_RESOURCE_GROUP" \
      --query "properties.defaultDomain" -o tsv 2>/dev/null || echo "<defaultDomain from Azure portal>")"
    warn ""
    warn "  Wait 1–5 min, verify:"
    warn "    dig _acme-challenge.${DOMAIN} TXT +short"
    warn "    dig asuid.${DOMAIN} TXT +short"
    warn "──────────────────────────────────────────────────────────────────────"
    read -r -p "Press Enter when TXT records are live..."
    echo ""

    info "Completing certificate issuance..."
    "$ACME" --renew \
      --domain "${WILDCARD_DOMAIN}" \
      --domain "${DOMAIN}" \
      --server letsencrypt \
      --keylength 2048 \
      --yes-I-know-dns-manual-mode-enough-go-ahead-please

  else
    # renew subcommand
    if [[ -f "${CERTS_DIR}/wildcard.crt" ]]; then
      EXPIRY=$(openssl x509 -in "${CERTS_DIR}/wildcard.crt" -noout -enddate 2>/dev/null | cut -d= -f2 || true)
      if [[ -n "$EXPIRY" ]]; then
        info "Current certificate expires: $EXPIRY"
      fi
    fi

    local renew_args=()
    [[ "$force" == "--force" ]] && renew_args+=("--force")

    info "Renewing certificate for ${WILDCARD_DOMAIN} ..."
    info "acme.sh will print a TXT record value — update it at Active24, then press Enter."
    echo ""

    "$ACME" --renew \
      --domain "${WILDCARD_DOMAIN}" \
      --domain "${DOMAIN}" \
      --server letsencrypt \
      --yes-I-know-dns-manual-mode-enough-go-ahead-please \
      "${renew_args[@]}" \
      || true

    echo ""
    warn "──────────────────────────────────────────────────────────────────────"
    warn "ACTION REQUIRED:"
    warn "  1. Log in to Active24 DNS panel"
    warn "  2. Update the TXT record for _acme-challenge.${DOMAIN}"
    warn "  3. Wait 1–5 minutes for DNS propagation"
    warn "  4. Verify:  dig _acme-challenge.${DOMAIN} TXT +short"
    warn "  5. Then press Enter to continue"
    warn "──────────────────────────────────────────────────────────────────────"
    read -r -p "Press Enter when TXT record is live..."
    echo ""

    info "Completing renewal..."
    "$ACME" --renew \
      --domain "${WILDCARD_DOMAIN}" \
      --domain "${DOMAIN}" \
      --server letsencrypt \
      --yes-I-know-dns-manual-mode-enough-go-ahead-please \
      "${renew_args[@]}"
  fi

  ok "Certificate issued/renewed"
}

# ── Step 4: Copy cert files ───────────────────────────────────────────────────

copy_certs() {
  info "Copying certificate files to ${CERTS_DIR}/ ..."

  # acme.sh stores certs under ~/.acme.sh/<domain>/ or ~/.acme.sh/<domain>_ecc/
  # The wildcard cert is keyed by the first --domain argument.
  ACME_CERT_DIR="${ACME_HOME}/${WILDCARD_DOMAIN}_ecc"
  if [[ ! -d "$ACME_CERT_DIR" ]]; then
    ACME_CERT_DIR="${ACME_HOME}/${WILDCARD_DOMAIN}"
  fi
  if [[ ! -d "$ACME_CERT_DIR" ]]; then
    # Try URL-encoded name (acme.sh uses * literally in dir name on some versions)
    ACME_CERT_DIR=$(find "$ACME_HOME" -maxdepth 1 -type d -name "*${DOMAIN}*" | head -1 || true)
  fi
  [[ -n "$ACME_CERT_DIR" && -d "$ACME_CERT_DIR" ]] || \
    error "Cannot locate acme.sh cert dir for ${WILDCARD_DOMAIN}. Expected: ${ACME_HOME}/${WILDCARD_DOMAIN}"

  info "Using acme.sh cert dir: $ACME_CERT_DIR"

  # acme.sh --install-cert writes the files to a specified location
  "$ACME" --install-cert \
    --domain "${WILDCARD_DOMAIN}" \
    --cert-file      "${CERTS_DIR}/wildcard.crt" \
    --key-file       "${CERTS_DIR}/wildcard.key" \
    --fullchain-file "${CERTS_DIR}/wildcard.crt"

  # Restrict key permissions
  chmod 600 "${CERTS_DIR}/wildcard.key"

  ok "Cert files written:"
  ok "  ${CERTS_DIR}/wildcard.crt  (fullchain)"
  ok "  ${CERTS_DIR}/wildcard.key  (private key — keep secret)"
}

# ── Step 5: Convert to PFX ────────────────────────────────────────────────────

convert_pfx() {
  info "Converting to PFX (no password)..."

  openssl pkcs12 -export \
    -in  "${CERTS_DIR}/wildcard.crt" \
    -inkey "${CERTS_DIR}/wildcard.key" \
    -out "${CERTS_DIR}/wildcard.pfx" \
    -passout pass:

  chmod 600 "${CERTS_DIR}/wildcard.pfx"
  ok "PFX written: ${CERTS_DIR}/wildcard.pfx"
}

# ── Step 6: Apply to Container Apps Environment ───────────────────────────────

apply_cert() {
  info "Applying certificate to Container Apps Environment '${DEPLOY_AGENT_CONTAINER_ENV_NAME}'..."

  # NOTE: az containerapp env update has a bug where it omits dnsSuffix from the
  # PATCH body, so the domain suffix is never applied. We use az rest directly.
  SUBSCRIPTION_ID=$(az account show --query id -o tsv)
  CERT_BASE64=$(base64 -i "${CERTS_DIR}/wildcard.pfx" | tr -d '\n')
  ENV_LOCATION=$(az containerapp env show \
    --name "$DEPLOY_AGENT_CONTAINER_ENV_NAME" \
    --resource-group "$DEPLOY_AGENT_CONTAINER_RESOURCE_GROUP" \
    --query location -o tsv)

  az rest --method PATCH \
    --url "https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${DEPLOY_AGENT_CONTAINER_RESOURCE_GROUP}/providers/Microsoft.App/managedEnvironments/${DEPLOY_AGENT_CONTAINER_ENV_NAME}?api-version=2024-03-01" \
    --headers "Content-Type=application/json" \
    --body "{
      \"location\": \"${ENV_LOCATION}\",
      \"properties\": {
        \"customDomainConfiguration\": {
          \"dnsSuffix\": \"${DOMAIN}\",
          \"certificateValue\": \"${CERT_BASE64}\",
          \"certificatePassword\": \"\"
        }
      }
    }"

  info "Waiting for Container Apps Environment to finish updating..."
  local max_wait=120
  local elapsed=0
  local interval=5

  while true; do
    STATE=$(az containerapp env show \
      --name    "$DEPLOY_AGENT_CONTAINER_ENV_NAME" \
      --resource-group "$DEPLOY_AGENT_CONTAINER_RESOURCE_GROUP" \
      --query "properties.provisioningState" -o tsv 2>/dev/null || echo "Unknown")

    if [[ "$STATE" == "Succeeded" ]]; then
      ok "Container Apps Environment is ready (state: $STATE)"
      break
    elif [[ "$STATE" == "Failed" ]]; then
      error "Container Apps Environment update failed (state: $STATE)"
    fi

    if (( elapsed >= max_wait )); then
      warn "Timed out waiting for environment (state: $STATE). Check Azure portal."
      break
    fi

    info "  Current state: $STATE — waiting ${interval}s..."
    sleep "$interval"
    (( elapsed += interval ))
  done

  # Show applied config
  az containerapp env show \
    --name    "$DEPLOY_AGENT_CONTAINER_ENV_NAME" \
    --resource-group "$DEPLOY_AGENT_CONTAINER_RESOURCE_GROUP" \
    --query "{dnsSuffix:properties.customDomainConfiguration.dnsSuffix, thumbprint:properties.customDomainConfiguration.thumbprint, expiry:properties.customDomainConfiguration.expirationDate}" \
    -o json

  ok "Certificate applied to Container Apps Environment"
}

# ── Main ──────────────────────────────────────────────────────────────────────

SUBCOMMAND="${1:-}"
FORCE_FLAG="${2:-}"

case "$SUBCOMMAND" in
  setup)
    preflight
    install_acme
    issue_cert "setup"
    copy_certs
    convert_pfx
    apply_cert
    echo ""
    ok "══════════════════════════════════════════════════════════════════════"
    ok "  Certificate setup complete!"
    ok "  DNS suffix:  ${DOMAIN}"
    ok "  Cert files:  ${CERTS_DIR}/"
    ok "  Renew in ~60 days with:  ./infra/cert.sh renew"
    ok "══════════════════════════════════════════════════════════════════════"
    ;;
  renew)
    preflight
    install_acme
    issue_cert "renew" "$FORCE_FLAG"
    copy_certs
    convert_pfx
    apply_cert
    echo ""
    ok "══════════════════════════════════════════════════════════════════════"
    ok "  Certificate renewal complete!"
    ok "  Renew again in ~60 days with:  ./infra/cert.sh renew"
    ok "══════════════════════════════════════════════════════════════════════"
    ;;
  *)
    usage
    ;;
esac
