export declare function listBuildSourceUploadUrl(token: string): Promise<{
    uploadUrl: string;
    relativePath: string;
}>;
export declare function uploadSourceBlob(uploadUrl: string, content: Buffer): Promise<void>;
export declare function scheduleAcrBuild(token: string, imageTag: string, sourceLocation: string): Promise<string>;
export declare function pollAcrBuild(token: string, runId: string, onLog?: (line: string) => void): Promise<void>;
