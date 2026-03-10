export interface AppEntry {
    slug: string;
    name: string;
    description: string;
    deployedAt: string;
    deployedBy: string;
    url?: string;
    type?: "static" | "container";
    containerAppId?: string;
    imageRepository?: string;
    persistentStorage?: boolean;
}
export interface Registry {
    apps: AppEntry[];
}
export declare function loadRegistry(token: string): Promise<Registry>;
export declare function saveRegistry(token: string, registry: Registry): Promise<void>;
export declare function upsertApp(registry: Registry, entry: AppEntry): Registry;
export declare function removeApp(registry: Registry, slug: string): Registry;
