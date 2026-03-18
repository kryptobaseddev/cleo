/**
 * Adapter registry — discovers and provides access to provider manifests.
 *
 * Scans the providers/ directory for manifest.json files and returns
 * the discovered adapter manifests for use by AdapterManager.
 *
 * @task T5240
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
/** Known provider IDs bundled with @cleocode/adapters. */
const PROVIDER_IDS = ['claude-code', 'opencode', 'cursor'];
/**
 * Get the manifests for all bundled provider adapters.
 *
 * @returns Array of adapter manifests
 */
export function getProviderManifests() {
    const manifests = [];
    const baseDir = resolve(dirname(fileURLToPath(import.meta.url)), 'providers');
    for (const providerId of PROVIDER_IDS) {
        try {
            const manifestPath = join(baseDir, providerId, 'manifest.json');
            const raw = readFileSync(manifestPath, 'utf-8');
            manifests.push(JSON.parse(raw));
        }
        catch {
            // Skip providers whose manifests cannot be loaded
        }
    }
    return manifests;
}
/**
 * Discover all available provider adapters.
 *
 * Returns a map of provider ID to adapter factory function.
 */
export async function discoverProviders() {
    const providers = new Map();
    providers.set('claude-code', async () => {
        const { ClaudeCodeAdapter } = await import('./providers/claude-code/index.js');
        return new ClaudeCodeAdapter();
    });
    providers.set('opencode', async () => {
        const { OpenCodeAdapter } = await import('./providers/opencode/index.js');
        return new OpenCodeAdapter();
    });
    providers.set('cursor', async () => {
        const { CursorAdapter } = await import('./providers/cursor/index.js');
        return new CursorAdapter();
    });
    return providers;
}
//# sourceMappingURL=registry.js.map