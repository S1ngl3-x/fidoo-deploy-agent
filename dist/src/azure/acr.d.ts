export declare function acrBuildFromDir(sourceDir: string, imageTag: string): Promise<void>;
export declare function scheduleAcrBuild(token: string, imageTag: string, sasUrl: string): Promise<string>;
export declare function pollAcrBuild(token: string, runId: string, onLog?: (line: string) => void): Promise<void>;
