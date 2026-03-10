export declare function uploadBlob(token: string, blobPath: string, content: Buffer): Promise<void>;
export declare function downloadBlob(token: string, blobPath: string): Promise<Buffer | null>;
export declare function deleteBlob(token: string, blobPath: string): Promise<void>;
export declare function listBlobs(token: string, prefix?: string): Promise<string[]>;
export declare function deleteBlobsByPrefix(token: string, prefix: string): Promise<void>;
export declare function createBlobContainer(token: string, containerName: string): Promise<void>;
export declare function deleteBlobContainer(token: string, containerName: string): Promise<void>;
export declare function generateBlobSasUrl(token: string, blobPath: string): Promise<string>;
