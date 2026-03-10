import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface DeployConfig {
  appSlug: string;
  appName: string;
  appDescription: string;
  resourceId: string;
  appType?:           "static" | "container";
  containerAppId?:    string;
  imageRepository?:   string;
  persistentStorage?: boolean;
}

const FILE_NAME = ".deploy.json";

export function generateSlug(appName: string): string {
  return appName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
}

export async function readDeployConfig(dir: string): Promise<DeployConfig | null> {
  try {
    const raw = await readFile(join(dir, FILE_NAME), "utf8");
    return JSON.parse(raw) as DeployConfig;
  } catch {
    return null;
  }
}

export async function writeDeployConfig(dir: string, config: DeployConfig): Promise<void> {
  await writeFile(join(dir, FILE_NAME), JSON.stringify(config, null, 2) + "\n");
}
