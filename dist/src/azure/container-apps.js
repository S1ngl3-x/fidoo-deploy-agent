import { config } from "../config.js";
const CA_API = "2024-03-01";
function h(token) {
    return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}
// Create or update a Container App. Returns the public HTTPS URL.
// Polls until provisioning completes (5s interval, 5 min timeout).
export async function createOrUpdateContainerApp(token, opts) {
    const containerAppPath = `/subscriptions/${config.subscriptionId}/resourceGroups/${config.resourceGroup}/providers/Microsoft.App/containerApps/${opts.slug}`;
    const url = `${config.armBaseUrl}${containerAppPath}?api-version=${CA_API}`;
    const envId = `/subscriptions/${config.subscriptionId}/resourceGroups/${config.resourceGroup}/providers/Microsoft.App/managedEnvironments/${config.containerEnvName}`;
    const secrets = [
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
        if (!poll.ok)
            throw new Error(`Container App poll failed: ${poll.status} ${await poll.text()}`);
        const data = await poll.json();
        if (data.properties.provisioningState === "Succeeded") {
            return `https://${data.properties.configuration.ingress.fqdn}`;
        }
        if (data.properties.provisioningState === "Failed") {
            throw new Error("Container App provisioning failed");
        }
    }
    throw new Error("Container App provisioning timed out after 5 minutes");
}
export async function deleteContainerApp(token, slug) {
    const url = `${config.armBaseUrl}/subscriptions/${config.subscriptionId}/resourceGroups/${config.resourceGroup}/providers/Microsoft.App/containerApps/${slug}?api-version=${CA_API}`;
    const res = await fetch(url, { method: "DELETE", headers: h(token) });
    if (!res.ok && res.status !== 404) {
        throw new Error(`Container App delete failed: ${res.status} ${await res.text()}`);
    }
}
//# sourceMappingURL=container-apps.js.map