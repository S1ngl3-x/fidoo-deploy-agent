import { config } from "../config.js";
const ACR_API = "2019-06-01-preview";
function armHeaders(token) {
    return {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
    };
}
// Get a pre-authenticated upload URL from ACR for source code.
// Returns { uploadUrl, relativePath } — uploadUrl is Azure Files SAS,
// relativePath goes into scheduleAcrBuild as sourceLocation.
export async function listBuildSourceUploadUrl(token) {
    const url = `${config.armBaseUrl}/subscriptions/${config.subscriptionId}/resourceGroups/${config.resourceGroup}/providers/Microsoft.ContainerRegistry/registries/${config.acrName}/listBuildSourceUploadUrl?api-version=${ACR_API}`;
    const res = await fetch(url, {
        method: "POST",
        headers: armHeaders(token),
        body: JSON.stringify({}),
    });
    if (!res.ok) {
        throw new Error(`listBuildSourceUploadUrl failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json());
    return data;
}
// Upload a buffer to the pre-authenticated blob SAS URL from listBuildSourceUploadUrl.
// Single PUT with BlockBlob type — the URL is Azure Blob Storage, not Azure Files.
export async function uploadSourceBlob(uploadUrl, content) {
    const res = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
            "x-ms-blob-type": "BlockBlob",
            "Content-Type": "application/octet-stream",
            "Content-Length": String(content.length),
        },
        body: new Uint8Array(content),
    });
    if (!res.ok) {
        throw new Error(`Source blob upload failed: ${res.status} ${await res.text()}`);
    }
}
// Trigger an ACR Tasks build using the ARM REST API.
// imageTag: just "slug:timestamp" (no login server prefix — ACR handles that)
// sourceLocation: relative path from listBuildSourceUploadUrl (NOT a full URL)
// Returns: the run ID string
export async function scheduleAcrBuild(token, imageTag, sourceLocation) {
    const url = `${config.armBaseUrl}/subscriptions/${config.subscriptionId}/resourceGroups/${config.resourceGroup}/providers/Microsoft.ContainerRegistry/registries/${config.acrName}/scheduleRun?api-version=${ACR_API}`;
    const body = {
        type: "DockerBuildRequest",
        imageNames: [imageTag],
        dockerFilePath: "Dockerfile",
        platform: { os: "Linux", architecture: "amd64" },
        sourceLocation,
        isPushEnabled: true,
    };
    const res = await fetch(url, {
        method: "POST",
        headers: armHeaders(token),
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        throw new Error(`ACR scheduleRun failed: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    return data.properties.runId;
}
// Poll until the build succeeds or fails. 5s interval, 10 minute timeout.
export async function pollAcrBuild(token, runId, onLog) {
    const runUrl = `${config.armBaseUrl}/subscriptions/${config.subscriptionId}/resourceGroups/${config.resourceGroup}/providers/Microsoft.ContainerRegistry/registries/${config.acrName}/runs/${runId}?api-version=${ACR_API}`;
    for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const res = await fetch(runUrl, { headers: armHeaders(token) });
        if (!res.ok) {
            throw new Error(`ACR poll failed: ${res.status} ${await res.text()}`);
        }
        const data = await res.json();
        const status = data.properties.status;
        onLog?.(`[ACR] Run ${runId}: ${status}`);
        if (status === "Succeeded")
            return;
        if (status === "Failed" || status === "Canceled" || status === "Error") {
            throw new Error(`ACR build ${runId} ended with status: ${status}`);
        }
    }
    throw new Error(`ACR build ${runId} timed out after 10 minutes`);
}
//# sourceMappingURL=acr.js.map