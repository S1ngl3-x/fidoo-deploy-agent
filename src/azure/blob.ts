import { createHmac } from "node:crypto";
import { config } from "../config.js";

// ── Auth helpers ────────────────────────────────────────────────────────────

function useKey(): boolean {
  return !!config.storageKey;
}

/**
 * Compute `Authorization: SharedKey {account}:{sig}` headers for any
 * Azure Storage REST request.  All x-ms-* headers, Content-Type, and
 * Content-Length must be passed in `extra` so they are included in the
 * signature.
 */
function sharedKeyHeaders(
  method: string,
  url: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const msDate = new Date().toUTCString();
  const all: Record<string, string> = {
    "x-ms-date": msDate,
    "x-ms-version": config.storageApiVersion,
    ...extra,
  };

  // Canonicalized headers — sorted, lower-cased x-ms-* keys
  const canonHeaders = Object.keys(all)
    .filter((k) => k.toLowerCase().startsWith("x-ms-"))
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map((k) => `${k.toLowerCase()}:${all[k].trim()}`)
    .join("\n");

  // Canonicalized resource — /{account}{path}\n{sorted query params}
  const parsed = new URL(url);
  let canonResource = `/${config.storageAccount}${parsed.pathname}`;
  const params = [...parsed.searchParams.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [k, v] of params) {
    canonResource += `\n${k.toLowerCase()}:${v}`;
  }

  // Content-Length must be empty string when 0 or absent
  const cl = all["Content-Length"];
  const contentLength = cl && cl !== "0" ? cl : "";

  const stringToSign = [
    method.toUpperCase(),
    "",                          // Content-Encoding
    "",                          // Content-Language
    contentLength,               // Content-Length
    "",                          // Content-MD5
    all["Content-Type"] ?? "",   // Content-Type
    "",                          // Date  (empty — x-ms-date used instead)
    "",                          // If-Modified-Since
    "",                          // If-Match
    "",                          // If-None-Match
    "",                          // If-Unmodified-Since
    "",                          // Range
    canonHeaders,
    canonResource,
  ].join("\n");

  const sig = createHmac("sha256", Buffer.from(config.storageKey, "base64"))
    .update(stringToSign, "utf-8")
    .digest("base64");

  all["Authorization"] = `SharedKey ${config.storageAccount}:${sig}`;
  return all;
}

/** Return auth headers — SharedKey when account key is available, Bearer otherwise. */
function authHeaders(
  token: string,
  method: string,
  url: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  if (useKey()) {
    return sharedKeyHeaders(method, url, extra);
  }
  return {
    Authorization: `Bearer ${token}`,
    "x-ms-version": config.storageApiVersion,
    ...extra,
  };
}

// ── URL helpers ─────────────────────────────────────────────────────────────

function blobUrl(blobPath: string): string {
  return `https://${config.storageAccount}.blob.core.windows.net/${config.containerName}/${blobPath}`;
}

// ── Blob CRUD ───────────────────────────────────────────────────────────────

export async function uploadBlob(token: string, blobPath: string, content: Buffer): Promise<void> {
  const url = blobUrl(blobPath);
  const resp = await fetch(url, {
    method: "PUT",
    headers: authHeaders(token, "PUT", url, {
      "x-ms-blob-type": "BlockBlob",
      "Content-Type": "application/octet-stream",
      "Content-Length": String(content.length),
    }),
    body: new Uint8Array(content),
  });
  if (!resp.ok) throw new Error(`Blob upload failed: ${resp.status} ${await resp.text()}`);
}

export async function downloadBlob(token: string, blobPath: string): Promise<Buffer | null> {
  const url = blobUrl(blobPath);
  const resp = await fetch(url, {
    method: "GET",
    headers: authHeaders(token, "GET", url),
  });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`Blob download failed: ${resp.status} ${await resp.text()}`);
  return Buffer.from(await resp.arrayBuffer());
}

export async function deleteBlob(token: string, blobPath: string): Promise<void> {
  const url = blobUrl(blobPath);
  const resp = await fetch(url, {
    method: "DELETE",
    headers: authHeaders(token, "DELETE", url),
  });
  if (!resp.ok && resp.status !== 404) {
    throw new Error(`Blob delete failed: ${resp.status} ${await resp.text()}`);
  }
}

export async function listBlobs(token: string, prefix?: string): Promise<string[]> {
  let url = `https://${config.storageAccount}.blob.core.windows.net/${config.containerName}?restype=container&comp=list`;
  if (prefix) url += `&prefix=${encodeURIComponent(prefix)}`;
  const resp = await fetch(url, {
    method: "GET",
    headers: authHeaders(token, "GET", url),
  });
  if (!resp.ok) throw new Error(`Blob list failed: ${resp.status} ${await resp.text()}`);
  const xml = await resp.text();
  const names: string[] = [];
  const regex = /<Name>([^<]+)<\/Name>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null) names.push(match[1]);
  return names;
}

export async function deleteBlobsByPrefix(token: string, prefix: string): Promise<void> {
  const blobs = await listBlobs(token, prefix);
  await Promise.all(blobs.map((name) => deleteBlob(token, name)));
}

// ── Container operations ────────────────────────────────────────────────────

export async function createBlobContainer(token: string, containerName: string): Promise<void> {
  const url = `https://${config.storageAccount}.blob.core.windows.net/${containerName}?restype=container`;
  const resp = await fetch(url, {
    method: "PUT",
    headers: authHeaders(token, "PUT", url),
  });
  if (!resp.ok && resp.status !== 409) {
    throw new Error(`Failed to create blob container '${containerName}': ${resp.status} ${await resp.text()}`);
  }
}

export async function deleteBlobContainer(token: string, containerName: string): Promise<void> {
  const url = `https://${config.storageAccount}.blob.core.windows.net/${containerName}?restype=container`;
  const resp = await fetch(url, {
    method: "DELETE",
    headers: authHeaders(token, "DELETE", url),
  });
  if (!resp.ok && resp.status !== 404) {
    throw new Error(`Failed to delete blob container '${containerName}': ${resp.status} ${await resp.text()}`);
  }
}

// ── SAS URL generation ──────────────────────────────────────────────────────

/** Service SAS — signed directly with the account key (no delegation key). */
function generateServiceSas(blobPath: string): string {
  const now = new Date();
  const start = now.toISOString().replace(/\.\d{3}Z/, "Z");
  const expiry = new Date(now.getTime() + 3600_000).toISOString().replace(/\.\d{3}Z/, "Z");

  const canonicalizedResource = `/blob/${config.storageAccount}/${config.containerName}/${blobPath}`;

  const stringToSign = [
    "r",                        // signedPermissions
    start,                      // signedStart
    expiry,                     // signedExpiry
    canonicalizedResource,
    "",                         // signedIdentifier
    "",                         // signedIP
    "https",                    // signedProtocol
    config.storageApiVersion,   // signedVersion
    "b",                        // signedResource  (blob)
    "",                         // signedSnapshotTime
    "",                         // signedEncryptionScope
    "",                         // rscc  (Cache-Control)
    "",                         // rscd  (Content-Disposition)
    "",                         // rsce  (Content-Encoding)
    "",                         // rscl  (Content-Language)
    "",                         // rsct  (Content-Type)
  ].join("\n");

  const sig = createHmac("sha256", Buffer.from(config.storageKey, "base64"))
    .update(stringToSign, "utf-8")
    .digest("base64");

  const params = new URLSearchParams({
    sp: "r",
    st: start,
    se: expiry,
    spr: "https",
    sv: config.storageApiVersion,
    sr: "b",
    sig,
  });

  return `${blobUrl(blobPath)}?${params.toString()}`;
}

/** User Delegation SAS — requires OAuth token + Storage Blob Data Contributor. */
interface UserDelegationKey {
  signedOid: string;
  signedTid: string;
  signedStart: string;
  signedExpiry: string;
  signedService: string;
  signedVersion: string;
  value: string;
}

async function getUserDelegationKey(token: string): Promise<UserDelegationKey> {
  const now = new Date();
  const start = now.toISOString().replace(/\.\d{3}Z/, "Z");
  const expiry = new Date(now.getTime() + 3600_000).toISOString().replace(/\.\d{3}Z/, "Z");

  const url = `https://${config.storageAccount}.blob.core.windows.net/?restype=service&comp=userdelegationkey`;
  const resp = await fetch(url, {
    method: "POST",
    headers: authHeaders(token, "POST", url, { "Content-Type": "application/xml" }),
    body: `<?xml version="1.0" encoding="utf-8"?><KeyInfo><Start>${start}</Start><Expiry>${expiry}</Expiry></KeyInfo>`,
  });

  if (!resp.ok) {
    throw new Error(`User delegation key request failed: ${resp.status} ${await resp.text()}`);
  }

  const xml = await resp.text();
  const extract = (tag: string): string => {
    const match = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
    return match?.[1] ?? "";
  };

  return {
    signedOid: extract("SignedOid"),
    signedTid: extract("SignedTid"),
    signedStart: extract("SignedStart"),
    signedExpiry: extract("SignedExpiry"),
    signedService: extract("SignedService"),
    signedVersion: extract("SignedVersion"),
    value: extract("Value"),
  };
}

export async function generateBlobSasUrl(token: string, blobPath: string): Promise<string> {
  // Service SAS with account key — simpler, no RBAC data-plane role needed
  if (useKey()) return generateServiceSas(blobPath);

  // User Delegation SAS — requires Storage Blob Data Contributor
  const key = await getUserDelegationKey(token);

  const now = new Date();
  const start = now.toISOString().replace(/\.\d{3}Z/, "Z");
  const expiry = new Date(now.getTime() + 3600_000).toISOString().replace(/\.\d{3}Z/, "Z");

  const canonicalizedResource = `/blob/${config.storageAccount}/${config.containerName}/${blobPath}`;

  const stringToSign = [
    "r",                        // signedPermissions
    start,                      // signedStart
    expiry,                     // signedExpiry
    canonicalizedResource,
    key.signedOid,              // signedKeyObjectId
    key.signedTid,              // signedKeyTenantId
    key.signedStart,            // signedKeyStart
    key.signedExpiry,           // signedKeyExpiry
    key.signedService,          // signedKeyService
    key.signedVersion,          // signedKeyVersion
    "",                         // signedAuthorizedUserObjectId
    "",                         // signedUnauthorizedUserObjectId
    "",                         // signedCorrelationId
    "",                         // signedIP
    "https",                    // signedProtocol
    config.storageApiVersion,   // signedVersion
    "b",                        // signedResource (blob)
    "",                         // signedSnapshotTime
    "",                         // signedEncryptionScope
    "",                         // rscc (Cache-Control)
    "",                         // rscd (Content-Disposition)
    "",                         // rsce (Content-Encoding)
    "",                         // rscl (Content-Language)
    "",                         // rsct (Content-Type)
  ].join("\n");

  const sig = createHmac("sha256", Buffer.from(key.value, "base64"))
    .update(stringToSign, "utf-8")
    .digest("base64");

  const params = new URLSearchParams({
    sp: "r",
    st: start,
    se: expiry,
    spr: "https",
    sv: config.storageApiVersion,
    sr: "b",
    skoid: key.signedOid,
    sktid: key.signedTid,
    skt: key.signedStart,
    ske: key.signedExpiry,
    sks: key.signedService,
    skv: key.signedVersion,
    sig,
  });

  return `${blobUrl(blobPath)}?${params.toString()}`;
}
