import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";
const execFileAsync = promisify(execFile);
const ACR_API = "2019-06-01-preview";
// Build and push image using az acr build (no Docker needed, no SAS URL needed).
// imageTag: "slug:timestamp" — login server prefix is added automatically by ACR.
export async function acrBuildFromDir(sourceDir, imageTag) {
    await execFileAsync("az", [
        "acr", "build",
        "--registry", config.acrName,
        "--image", imageTag,
        "--platform", "linux/amd64",
        sourceDir,
    ], { maxBuffer: 20 * 1024 * 1024 });
}
function armHeaders(token) {
    return {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
    };
}
// Trigger an ACR Tasks build using the ARM REST API.
// imageTag: just "slug:timestamp" (no login server prefix — ACR handles that)
// sasUrl: SAS URL pointing to the source tar.gz in blob storage
// Returns: the run ID string
export async function scheduleAcrBuild(token, imageTag, sasUrl) {
    const url = `${config.armBaseUrl}/subscriptions/${config.subscriptionId}/resourceGroups/${config.resourceGroup}/providers/Microsoft.ContainerRegistry/registries/${config.acrName}/scheduleRun?api-version=${ACR_API}`;
    const body = {
        type: "DockerBuildRequest",
        imageNames: [imageTag],
        dockerFilePath: "Dockerfile",
        platform: { os: "Linux", architecture: "amd64" },
        sourceLocation: sasUrl,
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