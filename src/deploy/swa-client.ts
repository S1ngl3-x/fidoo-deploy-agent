/**
 * Downloads and runs the StaticSitesClient binary for SWA deployment.
 * Same binary used by @azure/static-web-apps-cli under the hood.
 */

import childProcess from "node:child_process";
import { readFile, writeFile, mkdir, chmod, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// Manual promisification of execFile that goes through the module namespace
// on each call, so tests can mock via mock.method(childProcess, "execFile", ...).
function execAsync(
  file: string,
  args: readonly string[],
  options: { timeout: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    childProcess.execFile(file, [...args], options, (error, stdout, stderr) => {
      if (error) return reject(error);
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

const STABLE_URL = "https://aka.ms/swalocaldeploy";
const CACHE_DIR = join(homedir(), ".swa", "deploy");

function platformKey(): "osx-x64" | "linux-x64" | "win-x64" {
  switch (process.platform) {
    case "darwin":
      return "osx-x64";
    case "linux":
      return "linux-x64";
    case "win32":
      return "win-x64";
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

interface VersionMeta {
  version: string;
  buildId: string;
  files: Record<string, { url: string; sha: string }>;
}

interface CachedMeta {
  binary: string;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function getCachedBinary(): Promise<string | null> {
  const metaFile = join(CACHE_DIR, "StaticSitesClient.json");
  if (!(await fileExists(metaFile))) return null;
  try {
    const meta = JSON.parse(await readFile(metaFile, "utf-8")) as CachedMeta;
    if (meta.binary && (await fileExists(meta.binary))) return meta.binary;
  } catch {
    // Corrupted metadata — re-download
  }
  return null;
}

async function downloadBinary(): Promise<string> {
  const resp = await fetch(STABLE_URL);
  if (!resp.ok) throw new Error(`Failed to fetch SWA client metadata: ${resp.status}`);
  const versions = (await resp.json()) as VersionMeta[];
  const meta = versions.find((v) => v.version === "stable");
  if (!meta) throw new Error("No stable SWA client version found in metadata");

  const platform = platformKey();
  const info = meta.files[platform];
  if (!info) throw new Error(`No SWA client binary for ${platform}`);

  const buildDir = join(CACHE_DIR, meta.buildId);
  const binaryName =
    process.platform === "win32" ? "StaticSitesClient.exe" : "StaticSitesClient";
  const binaryPath = join(buildDir, binaryName);

  if (await fileExists(binaryPath)) return binaryPath;

  await mkdir(buildDir, { recursive: true });
  const binResp = await fetch(info.url);
  if (!binResp.ok) throw new Error(`Failed to download SWA client: ${binResp.status}`);
  const buffer = Buffer.from(await binResp.arrayBuffer());
  await writeFile(binaryPath, buffer);
  await chmod(binaryPath, 0o755);

  // Update cache metadata
  await writeFile(
    join(CACHE_DIR, "StaticSitesClient.json"),
    JSON.stringify({ metadata: meta, binary: binaryPath, checksum: info.sha }),
  );

  return binaryPath;
}

export async function ensureSwaClient(): Promise<string> {
  return (await getCachedBinary()) ?? (await downloadBinary());
}

export async function deploySwaContent(
  apiToken: string,
  outputDir: string,
): Promise<void> {
  const binary = await ensureSwaClient();

  const { stdout, stderr } = await execAsync(binary, [
    "upload",
    "--app",
    outputDir,
    "--outputLocation",
    outputDir,
    "--apiToken",
    apiToken,
    "--skipAppBuild",
    "--deploymentProvider",
    "DeployAgent",
  ], { timeout: 120_000 });

  // StaticSitesClient writes status to stdout with ANSI codes.
  // Check for failure indicators in the combined output.
  const output = `${stdout}\n${stderr}`;
  if (/Failed to|Exiting/i.test(output) && !/Succeeded/.test(output)) {
    throw new Error(`SWA deployment failed: ${output}`);
  }
}
