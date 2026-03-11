import { config } from "../config.js";
/**
 * Acquire a Microsoft Graph access token for the Graph SP using
 * client credentials flow. No user interaction required.
 */
export async function acquireGraphToken() {
    const url = `${config.entraBaseUrl}/${config.tenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: config.graphSpClientId,
        client_secret: config.graphSpClientSecret,
        scope: "https://graph.microsoft.com/.default",
    });
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
    });
    if (!res.ok) {
        throw new Error(`Graph token acquisition failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json());
    return data.access_token;
}
//# sourceMappingURL=graph-token.js.map