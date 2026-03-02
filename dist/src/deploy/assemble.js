import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { listBlobs, downloadBlob } from "../azure/blob.js";
import { generateDashboardHtml } from "./dashboard.js";
import { config } from "../config.js";
export async function assembleSite(token, registry, outDir) {
    // 1. Write dashboard index.html at root
    const html = generateDashboardHtml(registry.apps);
    await writeFile(join(outDir, "index.html"), html, "utf-8");
    // 2. Write registry.json at root
    await writeFile(join(outDir, "registry.json"), JSON.stringify(registry, null, 2), "utf-8");
    // 3. Write staticwebapp.config.json — require Entra ID login for all routes,
    //    using the custom "Deploy Portal" AAD app (avoids B2B guest pending-approval screen).
    //    PORTAL_CLIENT_ID and PORTAL_CLIENT_SECRET are set as SWA app settings by setup.sh.
    const swaConfig = {
        auth: {
            identityProviders: {
                azureActiveDirectory: {
                    registration: {
                        openIdIssuer: `https://login.microsoftonline.com/${config.tenantId}/v2.0`,
                        clientIdSettingName: "PORTAL_CLIENT_ID",
                        clientSecretSettingName: "PORTAL_CLIENT_SECRET",
                    },
                },
            },
        },
        routes: [
            { route: "/.auth/*", allowedRoles: ["anonymous"] },
            { route: "/*", allowedRoles: ["authenticated"] },
        ],
        responseOverrides: {
            "401": { redirect: "/.auth/login/aad?post_login_redirect_uri=.referrer", statusCode: 302 },
        },
    };
    await writeFile(join(outDir, "staticwebapp.config.json"), JSON.stringify(swaConfig, null, 2), "utf-8");
    // 4. Download all app files from blob into subdirectories
    const allBlobs = await listBlobs(token);
    const appBlobs = allBlobs.filter((name) => name !== "registry.json");
    await Promise.all(appBlobs.map(async (blobName) => {
        const content = await downloadBlob(token, blobName);
        if (!content)
            return;
        const filePath = join(outDir, blobName);
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, content);
    }));
}
//# sourceMappingURL=assemble.js.map