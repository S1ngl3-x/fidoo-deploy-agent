import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const EXCLUDE_DIRS = [
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  "target",
  ".claude",
];

const EXCLUDE_FILES = [
  ".deploy.json",
  ".env",
  ".DS_Store",
  ".npmrc",
];

const EXCLUDE_EXTENSIONS = [
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".pyc",
];

export async function createTarball(sourceDir: string): Promise<Buffer> {
  const tmpFile = path.join(os.tmpdir(), `deploy-build-${Date.now()}.tar.gz`);

  const args: string[] = ["-czf", tmpFile];

  for (const dir of EXCLUDE_DIRS) {
    args.push(`--exclude=./${dir}`);
  }
  for (const file of EXCLUDE_FILES) {
    args.push(`--exclude=${file}`);
  }
  for (const ext of EXCLUDE_EXTENSIONS) {
    args.push(`--exclude=*${ext}`);
  }

  args.push("-C", sourceDir, ".");

  await execFileAsync("tar", args);

  const buf = await readFile(tmpFile);
  rm(tmpFile).catch(() => {}); // cleanup, fire and forget
  return buf;
}
