export declare function isLoopbackConnectionString(connectionString: string): boolean;
export declare function localNeonFetch(url: string, init: { headers: Record<string, string>; body: string }): Promise<Response>;
export declare function installLocalNeonFetch(): void;
export declare function closeLocalNeonPools(): Promise<void>;
