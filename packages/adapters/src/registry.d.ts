/**
 * Adapter registry — discovers and provides access to provider manifests.
 *
 * Scans the providers/ directory for manifest.json files and returns
 * the discovered adapter manifests for use by AdapterManager.
 *
 * @task T5240
 */
/** Minimal manifest shape for provider discovery. */
export interface AdapterManifest {
    id: string;
    name: string;
    version: string;
    description: string;
    provider: string;
    entryPoint: string;
    capabilities: Record<string, unknown>;
    detectionPatterns: Array<{
        type: string;
        pattern: string;
        description: string;
    }>;
}
/**
 * Get the manifests for all bundled provider adapters.
 *
 * @returns Array of adapter manifests
 */
export declare function getProviderManifests(): AdapterManifest[];
/**
 * Discover all available provider adapters.
 *
 * Returns a map of provider ID to adapter factory function.
 */
export declare function discoverProviders(): Promise<Map<string, () => Promise<unknown>>>;
//# sourceMappingURL=registry.d.ts.map