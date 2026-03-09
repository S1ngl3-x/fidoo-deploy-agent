import { createHmac } from "node:crypto";
import { execFile } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../config.js";

const execFileAsync = promisify(execFile);

// ── az CLI blob helpers (Contributor-safe, no RBAC data-plane role needed) ──

function useKey(): boolean {
  return !!config.storageKey;
}

async function azBlob(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("az", [
    "storage", "blob", ...args,
    "--account-name", config.storageAccount,
    "--account-key", config.storageKey,
    "--container-name", config.containerName,
    "--output", "json",
    "--only-show-errors",
  ]);
  return stdout;
}

async function azContainer(args: string[], containerName: string): Promise<string> {
  const { stdout } = await execFileAsync("az", [
    "storage", "container", ...args,
    "--account-name", config.storageAccount,
    "--account-key", config.storageKey,
    "--name", containerName,
    "--output", "json",
    "--only-show-errors",
  ]);
  return stdout;
}

function blobUrl(blobPath: string): string {
  return `https://${config.storageAccount}.blob.core.windows.net/${config.containerName}/${blobPath}`;
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "x-ms-version": config.storageApiVersion,
  };
}

export async function uploadBlob(token: string, blobPath: string, content: Buffer): Promise<void> {
  if (useKey()) {
    const tmp = join(tmpdir(), `blob-upload-${Date.now()}.bin`);
    writeFileSync(tmp, content);
    try {
      await azBlob(["upload", "--name", blobPath, "--file", tmp, "--overwrite"]);
    } finally {
      unlinkSync(tmp);
    }
    return;
  }
  const resp = await fetch(blobUrl(blobPath), {
    method: "PUT",
    headers: {
      ...authHeaders(token),
      "x-ms-blob-type": "BlockBlob",
      "Content-Type": "application/octet-stream",
      "Content-Length": String(content.length),
    },
    body: new Uint8Array(content),
  });
  if (!resp.ok) throw new Error(`Blob upload failed: ${resp.status} ${await resp.text()}`);
}

export async function downloadBlob(token: string, blobPath: string): Promise<Buffer | null> {
  if (useKey()) {
    const tmp = join(tmpdir(), `blob-download-${Date.now()}.bin`);
    try {
      await azBlob(["download", "--name", blobPath, "--file", tmp]);
      return readFileSync(tmp);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("BlobNotFound") || msg.includes("does not exist")) return null;
      throw e;
    } finally {
      try { unlinkSync(tmp); } catch { /* ignore */ }
    }
  }
  const resp = await fetch(blobUrl(blobPath), { method: "GET", headers: authHeaders(token) });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`Blob download failed: ${resp.status} ${await resp.text()}`);
  return Buffer.from(await resp.arrayBuffer());
}

export async function deleteBlob(token: string, blobPath: string): Promise<void> {
  if (useKey()) {
    await azBlob(["delete", "--name", blobPath]).catch(() => { /* 404 is fine */ });
    return;
  }
  const resp = await fetch(blobUrl(blobPath), { method: "DELETE", headers: authHeaders(token) });
  if (!resp.ok && resp.status !== 404) throw new Error(`Blob delete failed: ${resp.status} ${await resp.text()}`);
}

export async function listBlobs(token: string, prefix?: string): Promise<string[]> {
  if (useKey()) {
    const args = ["list", "--query", "[].name"];
    if (prefix) args.push("--prefix", prefix);
    const out = await azBlob(args);
    return JSON.parse(out) as string[];
  }
  let url = `https://${config.storageAccount}.blob.core.windows.net/${config.containerName}?restype=container&comp=list`;
  if (prefix) url += `&prefix=${encodeURIComponent(prefix)}`;
  const resp = await fetch(url, { method: "GET", headers: authHeaders(token) });
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

// ── User Delegation SAS ────────────────────────────────────────────────────

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

  const resp = await fetch(
    `https://${config.storageAccount}.blob.core.windows.net/?restype=service&comp=userdelegationkey`,
    {
      method: "POST",
      headers: {
        ...authHeaders(token),
        "Content-Type": "application/xml",
      },
      body: `<?xml version="1.0" encoding="utf-8"?><KeyInfo><Start>${start}</Start><Expiry>${expiry}</Expiry></KeyInfo>`,
    },
  );

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
  if (useKey()) {
    const expiry = new Date(Date.now() + 3600_000).toISOString().replace(/\.\d{3}Z/, "Z");
    const { stdout } = await execFileAsync("az", [
      "storage", "blob", "generate-sas",
      "--account-name", config.storageAccount,
      "--account-key", config.storageKey,
      "--container-name", config.containerName,
      "--name", blobPath,
      "--permissions", "r",
      "--expiry", expiry,
      "--https-only",
      "--full-uri",
      "--output", "tsv",
      "--only-show-errors",
    ]);
    return stdout.trim();
  }

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

export async function createBlobContainer(token: string, containerName: string): Promise<void> {
  if (useKey()) {
    await azContainer(["create"], containerName).catch(() => { /* 409 already exists is fine */ });
    return;
  }
  const resp = await fetch(
    `https://${config.storageAccount}.blob.core.windows.net/${containerName}?restype=container`,
    { method: "PUT", headers: authHeaders(token) },
  );
  if (!resp.ok && resp.status !== 409) {
    throw new Error(`Failed to create blob container '${containerName}': ${resp.status} ${await resp.text()}`);
  }
}

export async function deleteBlobContainer(token: string, containerName: string): Promise<void> {
  if (useKey()) {
    await azContainer(["delete"], containerName).catch(() => { /* 404 is fine */ });
    return;
  }
  const resp = await fetch(
    `https://${config.storageAccount}.blob.core.windows.net/${containerName}?restype=container`,
    { method: "DELETE", headers: authHeaders(token) },
  );
  if (!resp.ok && resp.status !== 404) {
    throw new Error(`Failed to delete blob container '${containerName}': ${resp.status} ${await resp.text()}`);
  }
}
