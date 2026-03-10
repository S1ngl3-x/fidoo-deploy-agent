export interface DeployConfig {
    appSlug: string;
    appName: string;
    appDescription: string;
    resourceId: string;
    appType?: "static" | "container";
    containerAppId?: string;
    imageRepository?: string;
    persistentStorage?: boolean;
}
export declare function generateSlug(appName: string): string;
export declare function readDeployConfig(dir: string): Promise<DeployConfig | null>;
export declare function writeDeployConfig(dir: string, config: DeployConfig): Promise<void>;
