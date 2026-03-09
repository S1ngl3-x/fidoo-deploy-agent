export function buildConfig() {
  return {
    tenantId: process.env.DEPLOY_AGENT_TENANT_ID ?? "7bcac0ca-0725-4318-9adc-e9b670a48e92",
    clientId: process.env.DEPLOY_AGENT_CLIENT_ID ?? "PLACEHOLDER_CLIENT_ID",
    subscriptionId: process.env.DEPLOY_AGENT_SUBSCRIPTION_ID ?? "PLACEHOLDER_SUBSCRIPTION_ID",
    resourceGroup: process.env.DEPLOY_AGENT_RESOURCE_GROUP ?? "rg-published-apps",
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
