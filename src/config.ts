import { fetchSecret } from "./auth/keyvault.js";

export function buildConfig() {
  return {
    tenantId: process.env.DEPLOY_AGENT_TENANT_ID ?? "7bcac0ca-0725-4318-9adc-e9b670a48e92",
    clientId: process.env.DEPLOY_AGENT_CLIENT_ID ?? "PLACEHOLDER_CLIENT_ID",
    subscriptionId: process.env.DEPLOY_AGENT_SUBSCRIPTION_ID ?? "PLACEHOLDER_SUBSCRIPTION_ID",
    resourceGroup: process.env.DEPLOY_AGENT_RESOURCE_GROUP ?? "rg-published-apps",
    containerResourceGroup: process.env.DEPLOY_AGENT_CONTAINER_RESOURCE_GROUP ?? (process.env.DEPLOY_AGENT_RESOURCE_GROUP ?? "rg-published-apps"),
    storageAccount: process.env.DEPLOY_AGENT_STORAGE_ACCOUNT ?? "PLACEHOLDER_STORAGE_ACCOUNT",
    containerName: process.env.DEPLOY_AGENT_CONTAINER_NAME ?? "app-content",
    appDomain: process.env.DEPLOY_AGENT_APP_DOMAIN ?? "ai-apps.env.fidoo.cloud",
    swaSlug:           process.env.DEPLOY_AGENT_SWA_SLUG           ?? "swa-ai-apps",
    // Container deploy
    acrName:           process.env.DEPLOY_AGENT_ACR_NAME           ?? "",
    acrLoginServer:    process.env.DEPLOY_AGENT_ACR_LOGIN_SERVER    ?? "",
    containerEnvName:  process.env.DEPLOY_AGENT_CONTAINER_ENV_NAME ?? "",
    containerDomain:   process.env.DEPLOY_AGENT_CONTAINER_DOMAIN   ?? "api.env.fidoo.cloud",
    pullIdentityId:    process.env.DEPLOY_AGENT_PULL_IDENTITY_ID    ?? "",
    storageKey:        process.env.DEPLOY_AGENT_STORAGE_KEY         ?? "",
    acrAdminUsername:  process.env.DEPLOY_AGENT_ACR_ADMIN_USERNAME  ?? "",
    acrAdminPassword:  process.env.DEPLOY_AGENT_ACR_ADMIN_PASSWORD  ?? "",
    // Easy Auth (reuses Deploy Portal AD app registration for container apps)
    portalClientId:      process.env.DEPLOY_AGENT_PORTAL_CLIENT_ID      ?? "",
    portalClientSecret:  process.env.DEPLOY_AGENT_PORTAL_CLIENT_SECRET  ?? "",
    portalObjectId:      process.env.DEPLOY_AGENT_PORTAL_OBJECT_ID      ?? "",
    graphSpClientId:     process.env.DEPLOY_AGENT_GRAPH_SP_CLIENT_ID     ?? "",
    graphSpClientSecret: process.env.DEPLOY_AGENT_GRAPH_SP_CLIENT_SECRET ?? "",
    keyVaultName:      process.env.DEPLOY_AGENT_KEY_VAULT_NAME      ?? "",
    vaultScope: "https://vault.azure.net/.default offline_access",
    defaultPort:       Number(process.env.DEPLOY_AGENT_DEFAULT_PORT ?? "8080"),
    armScope: "https://management.azure.com/.default offline_access",
    storageScope: "https://storage.azure.com/.default offline_access",
    armBaseUrl: "https://management.azure.com",
    entraBaseUrl: "https://login.microsoftonline.com",
    swaApiVersion: "2022-09-01",
    storageApiVersion: "2024-11-04",
    location: process.env.DEPLOY_AGENT_LOCATION ?? "westeurope",
    swaSkuName: "Standard",
    swaSkuTier: "Standard",
  };
}

export const config = buildConfig();

let secretsLoaded = false;

export async function loadSecrets(vaultToken: string): Promise<void> {
  if (secretsLoaded || !config.keyVaultName) return;

  const mapping: [string, keyof typeof config][] = [
    ["deploy-storage-key", "storageKey"],
    ["deploy-acr-admin-password", "acrAdminPassword"],
    ["deploy-portal-client-secret", "portalClientSecret"],
    ["deploy-graph-sp-client-secret", "graphSpClientSecret"],
  ];

  const needed = mapping.filter(([, field]) => !(config as any)[field]);
  if (needed.length === 0) {
    secretsLoaded = true;
    return;
  }

  const results = await Promise.all(
    needed.map(([vaultSecret]) =>
      fetchSecret(config.keyVaultName, vaultSecret, vaultToken),
    ),
  );

  for (let i = 0; i < needed.length; i++) {
    (config as any)[needed[i][1]] = results[i];
  }

  secretsLoaded = true;
}

/** Test-only: reset the idempotency flag so loadSecrets can be called again. */
export function resetSecretsLoaded(): void {
  secretsLoaded = false;
}
