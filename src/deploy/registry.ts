import { downloadBlob, uploadBlob } from "../azure/blob.js";

export interface AppEntry {
  slug: string;
  name: string;
  description: string;
  deployedAt: string;
  deployedBy: string;
  url?:               string;                  // container only
  type?:              "static" | "container";  // defaults to "static" if absent
  containerAppId?:    string;                  // container only
  imageRepository?:   string;                 // container only
  persistentStorage?: boolean;                // container only
}

export interface Registry {
  apps: AppEntry[];
}

const REGISTRY_BLOB = "registry.json";

export async function loadRegistry(token: string): Promise<Registry> {
  const buf = await downloadBlob(token, REGISTRY_BLOB);
  if (!buf) return { apps: [] };
  return JSON.parse(buf.toString("utf-8")) as Registry;
}

export async function saveRegistry(token: string, registry: Registry): Promise<void> {
  const json = JSON.stringify(registry, null, 2);
  await uploadBlob(token, REGISTRY_BLOB, Buffer.from(json, "utf-8"));
}

export function upsertApp(registry: Registry, entry: AppEntry): Registry {
  const apps = registry.apps.filter((a) => a.slug !== entry.slug);
  apps.push(entry);
  apps.sort((a, b) => a.slug.localeCompare(b.slug));
  return { apps };
}

export function removeApp(registry: Registry, slug: string): Registry {
  return { apps: registry.apps.filter((a) => a.slug !== slug) };
}
