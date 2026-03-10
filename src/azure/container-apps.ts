import { config } from "../config.js";
import { acquireGraphToken } from "../auth/graph-token.js";

const CA_API = "2024-03-01";

function h(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

export interface ContainerAppOptions {
  slug:               string;
  image:              string;   // full image ref: e.g. fidooapps.azurecr.io/myapp:1234567890
  port:               number;
  persistentStorage:  boolean;
  storageAccountName: string;
  storageAccountKey:  string;   // stored as Container App secret
  storageContainer:   string;
}

// Create or update a Container App. Returns the public HTTPS URL.
// Polls until provisioning completes (5s interval, 5 min timeout).
export async function createOrUpdateContainerApp(
  token: string,
  opts: ContainerAppOptions,
): Promise<string> {
  const containerAppPath = `/subscriptions/${config.subscriptionId}/resourceGroups/${config.resourceGroup}/providers/Microsoft.App/containerApps/${opts.slug}`;
  const url = `${config.armBaseUrl}${containerAppPath}?api-version=${CA_API}`;
  const envId = `/subscriptions/${config.subscriptionId}/resourceGroups/${config.resourceGroup}/providers/Microsoft.App/managedEnvironments/${config.containerEnvName}`;

  const secrets: { name: string; value: string }[] = [
    { name: "acr-admin-password", value: config.acrAdminPassword },
    ...(opts.persistentStorage
      ? [{ name: "azure-storage-account-key", value: opts.storageAccountKey }]
      : []),
  ];

  const envVars = opts.persistentStorage
    ? [
        { name: "DATA_DIR", value: "/data" },
        { name: "AZURE_STORAGE_ACCOUNT_NAME", value: opts.storageAccountName },
        { name: "AZURE_STORAGE_CONTAINER", value: opts.storageContainer },
        { name: "AZURE_STORAGE_ACCOUNT_KEY", secretRef: "azure-storage-account-key" },
      ]
    : [];

  const body = {
    location: config.location,
    properties: {
      environmentId: envId,
      configuration: {
        secrets,
        ingress: {
          external: true,
          targetPort: opts.port,
          transport: "http",
        },
        registries: [
          {
            server: config.acrLoginServer,
            username: config.acrAdminUsername,
            passwordSecretRef: "acr-admin-password",
          },
        ],
      },
      template: {
        containers: [
          {
            name: opts.slug,
            image: opts.image,
            env: envVars,
          },
        ],
        scale: {
          minReplicas: opts.persistentStorage ? 1 : 0,
          maxReplicas: opts.persistentStorage ? 1 : 3,
        },
      },
    },
  };

  const res = await fetch(url, {
    method: "PUT",
    headers: h(token),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Container App create/update failed: ${res.status} ${await res.text()}`);
  }

  // Poll until provisioning completes
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const poll = await fetch(url, { headers: h(token) });
    if (!poll.ok) throw new Error(`Container App poll failed: ${poll.status} ${await poll.text()}`);
    const data = await poll.json() as {
      properties: {
        provisioningState: string;
        configuration: { ingress: { fqdn: string } };
      };
    };
    if (data.properties.provisioningState === "Succeeded") {
      return `https://${data.properties.configuration.ingress.fqdn}`;
    }
    if (data.properties.provisioningState === "Failed") {
      throw new Error("Container App provisioning failed");
    }
  }

  throw new Error("Container App provisioning timed out after 5 minutes");
}

// Configure Easy Auth (built-in authentication) on a Container App.
// Reuses the Deploy Portal AD app registration so all apps share one auth boundary.
// Skipped silently when portalClientId is not configured.
export async function configureEasyAuth(
  token: string,
  slug: string,
): Promise<void> {
  if (!config.portalClientId || !config.portalClientSecret) {
    return; // Easy Auth not configured — skip silently
  }

  // 1. Register redirect URI on Deploy Portal app registration (requires Graph SP)
  if (config.graphSpClientId && config.portalObjectId) {
    const graphToken = await acquireGraphToken();
    await addRedirectUri(graphToken, slug);
  }

  const containerAppPath = `/subscriptions/${config.subscriptionId}/resourceGroups/${config.resourceGroup}/providers/Microsoft.App/containerApps/${slug}`;

  // 2. Inject portal client secret into Container App secrets
  const appUrl = `${config.armBaseUrl}${containerAppPath}?api-version=${CA_API}`;
  const appRes = await fetch(appUrl, { headers: h(token) });
  if (!appRes.ok) {
    throw new Error(`Easy Auth: failed to read Container App: ${appRes.status} ${await appRes.text()}`);
  }
  const appData = await appRes.json() as {
    properties: { configuration: { secrets: { name: string; value: string }[] } };
  };
  const existingSecrets = appData.properties.configuration.secrets ?? [];
  if (!existingSecrets.some((s: { name: string }) => s.name === "portal-client-secret")) {
    existingSecrets.push({ name: "portal-client-secret", value: config.portalClientSecret });
    await fetch(appUrl, {
      method: "PATCH",
      headers: h(token),
      body: JSON.stringify({
        properties: { configuration: { secrets: existingSecrets } },
      }),
    });
  }

  // 3. Configure authConfigs/current
  const authUrl = `${config.armBaseUrl}${containerAppPath}/authConfigs/current?api-version=${CA_API}`;
  const body = {
    properties: {
      platform: { enabled: true },
      globalValidation: {
        unauthenticatedClientAction: "RedirectToLoginPage",
        redirectToProvider: "azureactivedirectory",
      },
      identityProviders: {
        azureActiveDirectory: {
          registration: {
            openIdIssuerUrl: `https://login.microsoftonline.com/${config.tenantId}/v2.0`,
            clientId: config.portalClientId,
            clientSecretSettingName: "portal-client-secret",
          },
          validation: {
            allowedAudiences: [config.portalClientId],
          },
        },
      },
    },
  };

  const res = await fetch(authUrl, {
    method: "PUT",
    headers: h(token),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Easy Auth configuration failed: ${res.status} ${await res.text()}`);
  }
}

// Remove Easy Auth redirect URI from Deploy Portal app registration.
// Called from container_delete before the Container App is deleted.
// Skipped silently when Graph SP credentials are not configured.
export async function removeEasyAuth(slug: string): Promise<void> {
  if (!config.graphSpClientId || !config.portalObjectId) return;
  const graphToken = await acquireGraphToken();
  await removeRedirectUri(graphToken, slug);
}

// ── Graph redirect URI helpers ──────────────────────────────────────────────

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

function graphHeaders(graphToken: string): Record<string, string> {
  return { Authorization: `Bearer ${graphToken}`, "Content-Type": "application/json" };
}

function redirectUri(slug: string): string {
  return `https://${slug}.${config.containerDomain}/.auth/login/aad/callback`;
}

async function getRedirectUris(graphToken: string): Promise<string[]> {
  const url = `${GRAPH_BASE}/applications/${config.portalObjectId}`;
  const res = await fetch(url, { headers: graphHeaders(graphToken) });
  if (!res.ok) throw new Error(`Graph GET app failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { web: { redirectUris: string[] } };
  return data.web?.redirectUris ?? [];
}

async function patchRedirectUris(graphToken: string, uris: string[]): Promise<void> {
  const url = `${GRAPH_BASE}/applications/${config.portalObjectId}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: graphHeaders(graphToken),
    body: JSON.stringify({ web: { redirectUris: uris } }),
  });
  if (!res.ok) throw new Error(`Graph PATCH redirectUris failed: ${res.status} ${await res.text()}`);
}

export async function addRedirectUri(graphToken: string, slug: string): Promise<void> {
  const uri = redirectUri(slug);
  const existing = await getRedirectUris(graphToken);
  if (existing.includes(uri)) return; // idempotent
  await patchRedirectUris(graphToken, [...existing, uri]);
}

export async function removeRedirectUri(graphToken: string, slug: string): Promise<void> {
  const uri = redirectUri(slug);
  const existing = await getRedirectUris(graphToken);
  if (!existing.includes(uri)) return; // nothing to remove
  await patchRedirectUris(graphToken, existing.filter((u) => u !== uri));
}

// ── Container App lifecycle ────────────────────────────────────────────────

export async function deleteContainerApp(token: string, slug: string): Promise<void> {
  const url = `${config.armBaseUrl}/subscriptions/${config.subscriptionId}/resourceGroups/${config.resourceGroup}/providers/Microsoft.App/containerApps/${slug}?api-version=${CA_API}`;
  const res = await fetch(url, { method: "DELETE", headers: h(token) });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Container App delete failed: ${res.status} ${await res.text()}`);
  }
}
