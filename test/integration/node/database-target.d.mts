export declare const MARKER_TABLE: string;
export declare const MARKER_SQL: string;
export declare function readDevVar(name: string, file?: string): string | undefined;
export declare function databaseIdentity(connectionString: string): string;
export declare function remoteTargetProblem(testUrl: string, appUrls: (string | undefined)[]): string | null;
export declare function resolveIntegrationDatabase(): Promise<{ url: string; mode: "local" | "remote"; stop(): Promise<void> }>;
