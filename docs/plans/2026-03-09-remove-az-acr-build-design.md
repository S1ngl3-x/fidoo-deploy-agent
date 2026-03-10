# Remove `az acr build` Dependency — Design Document

**Date:** 2026-03-09
**Status:** Implemented & Verified
**Branch:** feat/remove-az-cli-dependency

---

## Problem

The PoC introduced `az acr build` (Azure CLI) as a runtime dependency in `src/azure/acr.ts`. The original design intended pure REST/HTTP throughout. `az` is an optional external tool that users must install separately and is inappropriate as a runtime dependency for an MCP server.

## Goal

Replace `az acr build` with equivalent ARM + Blob Storage REST calls. No local Docker required. No `az` CLI required.

---

## Root Cause of Original SAS URL Failure

Two separate issues caused the original blob-SAS-URL approach to fail:

1. **Wrong `sourceLocation` type.** The original implementation passed a full blob storage SAS URL as `sourceLocation`. ACR Tasks expects a **relative path** from its own internal store (returned by `listBuildSourceUploadUrl`), not a full URL.

2. **PAX tar format.** macOS `bsdtar` defaults to PAX format. ACR Tasks cannot parse PAX archives — it fails with the misleading error "failed to download context". The fix is `--format=gnutar` (GNU tar format works, as does Python's `tarfile` default USTAR format).

---

## Approach

Use ACR's `listBuildSourceUploadUrl` ARM endpoint, which is what `az acr build` uses internally.

### Flow

```
1. createTarball(folder)                         — tarball.ts (uses tar --format=gnutar)
2. listBuildSourceUploadUrl(armToken)            — ARM POST → { uploadUrl, relativePath }
3. uploadSourceBlob(uploadUrl, buffer)           — single BlockBlob PUT to Blob Storage SAS URL
4. scheduleAcrBuild(armToken, imageTag, relativePath)  — sourceLocation = relativePath (NOT a URL)
5. pollAcrBuild(armToken, runId)                 — unchanged
```

---

## Key Discovery: Upload URL is Blob Storage, Not Azure Files

Despite initial assumptions, `listBuildSourceUploadUrl` returns a **Blob Storage** SAS URL (`sp=cw`, create+write only), not an Azure Files URL. Upload is a single `PUT` with `x-ms-blob-type: BlockBlob` — no 2-step file creation needed.

```
PUT {uploadUrl}
Headers:
  x-ms-blob-type: BlockBlob
  Content-Type: application/octet-stream
  Content-Length: {byteLength}
Body: tar.gz bytes
```

---

## Tarball Format Requirement

**CRITICAL:** macOS `bsdtar` defaults to PAX format which ACR Tasks cannot parse. The `tar` command MUST use `--format=gnutar`:

```bash
tar --format=gnutar -czf output.tar.gz -C sourceDir .
```

Symptoms of PAX format: ACR Tasks returns "failed to download context" within 3-5 seconds even though the blob upload succeeds (201). The error is misleading — the download works fine, but ACR Tasks fails to parse the PAX archive.

---

## File Changes

### `src/azure/acr.ts`

- **Deleted** `acrBuildFromDir()` — the `az` CLI wrapper
- **Added** `listBuildSourceUploadUrl(token)` — ARM POST to get upload URL and relative path
- **Added** `uploadSourceBlob(uploadUrl, buffer)` — single BlockBlob PUT
- **Renamed** `sasUrl` parameter → `sourceLocation` in `scheduleAcrBuild()`

### `src/deploy/tarball.ts`

- **Added** `--format=gnutar` flag to tar command (required for ACR Tasks compatibility)

### `src/azure/container-apps.ts`

- **Added** `AZURE_STORAGE_CONNECTION_STRING` as a secret + env var (apps need full connection string, not just individual components)

### `src/tools/container-deploy.ts`

- Replaced single `acrBuildFromDir(folder, imageTag)` with the 5-step sequence above

---

## ARM Endpoint

```
POST https://management.azure.com/subscriptions/{sub}/resourceGroups/{rg}/
     providers/Microsoft.ContainerRegistry/registries/{name}/
     listBuildSourceUploadUrl?api-version=2019-06-01-preview

Response: { "relativePath": "tasks-source/YYYYMM/uuid.tar.gz", "uploadUrl": "https://acrtaskprod....blob.core.windows.net/..." }
```

---

## Constraints

- No local Docker required — build runs entirely in ACR Tasks (Azure cloud)
- No `az` CLI required after this change
- `tar` (standard Unix utility) remains a dependency via `tarball.ts` — must use GNU format
- `az` CLI dependency remains in `src/azure/blob.ts` — separate concern, not addressed here
