# Remove `az acr build` Dependency — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace `az acr build` in `src/azure/acr.ts` with pure ARM + Azure Files REST calls so the MCP server has zero `az` CLI dependency at runtime.

**Architecture:** Call `listBuildSourceUploadUrl` (ARM) to get a pre-authenticated Azure Files upload URL and a relative path. Upload the tar.gz to Azure Files via 2-step REST (create file, write ranges). Pass the relative path as `sourceLocation` to the existing `scheduleAcrBuild`. Poll with existing `pollAcrBuild`.

**Tech Stack:** TypeScript, Node.js `fetch`, Azure ARM REST API, Azure Files REST API

---

### Task 1: Add `listBuildSourceUploadUrl` to `acr.ts`

**Files:**
- Modify: `src/azure/acr.ts`

**Step 1: Add the function after the `armHeaders` helper (line 25)**

```typescript
// Get a pre-authenticated upload URL from ACR for source code.
// Returns { uploadUrl, relativePath } — uploadUrl is Azure Files SAS,
// relativePath goes into scheduleAcrBuild as sourceLocation.
export async function listBuildSourceUploadUrl(
  token: string,
): Promise<{ uploadUrl: string; relativePath: string }> {
  const url = `${config.armBaseUrl}/subscriptions/${config.subscriptionId}/resourceGroups/${config.resourceGroup}/providers/Microsoft.ContainerRegistry/registries/${config.acrName}/listBuildSourceUploadUrl?api-version=${ACR_API}`;

  const res = await fetch(url, {
    method: "POST",
    headers: armHeaders(token),
    body: JSON.stringify({}),
  });

  if (!res.ok) {
    throw new Error(`listBuildSourceUploadUrl failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { uploadUrl: string; relativePath: string };
  return data;
}
```

**Step 2: Build to verify no type errors**

Run: `cd /Users/adam.lipowski/Development/fidoo-deploy-agent && npm run build`
Expected: PASS

**Step 3: Commit**

```bash
git add src/azure/acr.ts
git commit -m "feat(acr): add listBuildSourceUploadUrl ARM call"
```

---

### Task 2: Add `uploadToAzureFiles` to `acr.ts`

**Files:**
- Modify: `src/azure/acr.ts`

**Step 1: Add the function after `listBuildSourceUploadUrl`**

```typescript
const FILES_API_VERSION = "2024-11-04";
const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB — Azure Files max range write

// Upload a buffer to a pre-authenticated Azure Files SAS URL.
// Two-step: create empty file, then write content in 4 MB chunks.
export async function uploadToAzureFiles(
  uploadUrl: string,
  content: Buffer,
): Promise<void> {
  // The uploadUrl already contains SAS params (?sv=...&sig=...).
  // For additional query params we append with "&".
  const separator = uploadUrl.includes("?") ? "&" : "?";

  // Step 1: Create the empty file
  const createRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "x-ms-type": "file",
      "x-ms-content-length": String(content.length),
      "x-ms-version": FILES_API_VERSION,
      "Content-Length": "0",
    },
  });
  if (!createRes.ok) {
    throw new Error(`Azure Files create failed: ${createRes.status} ${await createRes.text()}`);
  }

  // Step 2: Write content in chunks
  for (let offset = 0; offset < content.length; offset += CHUNK_SIZE) {
    const end = Math.min(offset + CHUNK_SIZE, content.length) - 1;
    const chunk = content.subarray(offset, end + 1);

    const rangeRes = await fetch(`${uploadUrl}${separator}comp=range`, {
      method: "PUT",
      headers: {
        "x-ms-write": "update",
        "x-ms-range": `bytes=${offset}-${end}`,
        "x-ms-version": FILES_API_VERSION,
        "Content-Length": String(chunk.length),
      },
      body: chunk,
    });
    if (!rangeRes.ok) {
      throw new Error(`Azure Files range write failed: ${rangeRes.status} ${await rangeRes.text()}`);
    }
  }
}
```

**Step 2: Build to verify no type errors**

Run: `cd /Users/adam.lipowski/Development/fidoo-deploy-agent && npm run build`
Expected: PASS

**Step 3: Commit**

```bash
git add src/azure/acr.ts
git commit -m "feat(acr): add uploadToAzureFiles with chunked range writes"
```

---

### Task 3: Rename `sasUrl` → `sourceLocation` in `scheduleAcrBuild`

**Files:**
- Modify: `src/azure/acr.ts:31-34`

**Step 1: Rename parameter and update comment**

Change:
```typescript
// sasUrl: SAS URL pointing to the source tar.gz in blob storage
// Returns: the run ID string
export async function scheduleAcrBuild(
  token: string,
  imageTag: string,
  sasUrl: string,
): Promise<string> {
```

To:
```typescript
// sourceLocation: relative path from listBuildSourceUploadUrl (NOT a full URL)
// Returns: the run ID string
export async function scheduleAcrBuild(
  token: string,
  imageTag: string,
  sourceLocation: string,
): Promise<string> {
```

Also update line 43: `sourceLocation: sasUrl,` → `sourceLocation,`

**Step 2: Build**

Run: `cd /Users/adam.lipowski/Development/fidoo-deploy-agent && npm run build`
Expected: PASS

**Step 3: Commit**

```bash
git add src/azure/acr.ts
git commit -m "refactor(acr): rename sasUrl param to sourceLocation"
```

---

### Task 4: Delete `acrBuildFromDir` and clean up imports

**Files:**
- Modify: `src/azure/acr.ts:1-18`

**Step 1: Remove the function and its imports**

Delete lines 1-18 (the `execFile`/`promisify` imports and `acrBuildFromDir` function). The file should start with:

```typescript
import { config } from "../config.js";

const ACR_API = "2019-06-01-preview";

function armHeaders(token: string): Record<string, string> {
```

**Step 2: Build**

Run: `cd /Users/adam.lipowski/Development/fidoo-deploy-agent && npm run build`
Expected: FAIL — `container-deploy.ts` still imports `acrBuildFromDir`. This is expected; we fix it in Task 5.

**Step 3: Commit (build broken intentionally — fixed in next task)**

```bash
git add src/azure/acr.ts
git commit -m "refactor(acr): delete acrBuildFromDir (az CLI dependency)"
```

---

### Task 5: Wire up `container-deploy.ts` to use the new functions

**Files:**
- Modify: `src/tools/container-deploy.ts`

**Step 1: Update imports (line 9)**

Replace:
```typescript
import { acrBuildFromDir } from "../azure/acr.js";
```

With:
```typescript
import { listBuildSourceUploadUrl, uploadToAzureFiles, scheduleAcrBuild, pollAcrBuild } from "../azure/acr.js";
import { createTarball } from "../deploy/tarball.js";
```

**Step 2: Replace the single `acrBuildFromDir` call (line 129-130)**

Replace:
```typescript
    // 1-3. Build and push image via az acr build (handles upload + build internally)
    await acrBuildFromDir(folder, `${slug}:${timestamp}`);
```

With:
```typescript
    // 1. Package source as tar.gz
    const tarball = await createTarball(folder);

    // 2. Get ACR upload URL
    const { uploadUrl, relativePath } = await listBuildSourceUploadUrl(armToken);

    // 3. Upload tar.gz to Azure Files
    await uploadToAzureFiles(uploadUrl, tarball);

    // 4. Trigger ACR Tasks build and wait for completion
    const runId = await scheduleAcrBuild(armToken, `${slug}:${timestamp}`, relativePath);
    await pollAcrBuild(armToken, runId);
```

**Step 3: Build**

Run: `cd /Users/adam.lipowski/Development/fidoo-deploy-agent && npm run build`
Expected: PASS

**Step 4: Commit**

```bash
git add src/tools/container-deploy.ts
git commit -m "feat(container-deploy): wire up pure REST ACR build flow"
```

---

### Task 6: Verify and test

**Step 1: Confirm no `az` references remain in `src/`**

Run: `grep -r "\"az\"" src/ --include="*.ts"` or use Grep tool
Expected: Zero matches (no `execFileAsync("az", ...)` calls in src)

Note: `tarball.ts` uses `execFileAsync("tar", ...)` — that's fine, `tar` is a standard Unix utility.

**Step 2: Rebuild dist**

Run: `cd /Users/adam.lipowski/Development/fidoo-deploy-agent && npm run build`
Expected: PASS, clean build

**Step 3: Commit dist**

```bash
git add dist/
git commit -m "chore: rebuild dist after removing az CLI dependency"
```

---

### Task 7: Test deploy (manual)

**Step 1: Restart Claude Code** (so MCP server picks up new dist)

**Step 2: Bootstrap tokens**

```bash
az account get-access-token --resource https://management.azure.com > /tmp/arm.json
az account get-access-token --resource https://storage.azure.com > /tmp/storage.json
# Write combined tokens to ~/.deploy-agent/tokens.json
```

**Step 3: Test deploy via MCP tool**

Call `container_deploy` with the sprint barometer app folder. Verify:
- Tarball is created (tar)
- Upload URL is obtained from ARM
- Upload to Azure Files succeeds
- ACR build starts and completes
- Container App is created/updated
- App is reachable at its URL

**Step 4: If successful, final commit**

```bash
git commit --allow-empty -m "test: manual deploy verified — az CLI fully removed from runtime"
```
