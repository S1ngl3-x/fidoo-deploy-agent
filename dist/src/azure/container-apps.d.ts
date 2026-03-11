export interface ContainerAppOptions {
    slug: string;
    image: string;
    port: number;
    persistentStorage: boolean;
    storageAccountName: string;
    storageAccountKey: string;
    storageContainer: string;
}
export declare function createOrUpdateContainerApp(token: string, opts: ContainerAppOptions): Promise<string>;
export declare function configureEasyAuth(token: string, slug: string): Promise<void>;
export declare function removeEasyAuth(slug: string): Promise<void>;
export declare function addRedirectUri(graphToken: string, slug: string): Promise<void>;
export declare function removeRedirectUri(graphToken: string, slug: string): Promise<void>;
export declare function deleteContainerApp(token: string, slug: string): Promise<void>;
