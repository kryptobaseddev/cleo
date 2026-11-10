/**
 * Adapter registry — discovers and provides access to provider manifests.
 *
 * Scans the providers/ directory for manifest.json files and returns
 * the discovered adapter manifests for use by AdapterManager.
 *
 * @task T5240
 */

export type { AdapterManifest } from '@cleocode/contracts';
export { getProviderManifests } from './manifests.js';

/**
 * Discover all available provider adapters.
 *
 * Returns a map of provider ID to adapter factory function.
 *
 * @remarks
 * Each factory lazily imports the provider module and constructs a new
 * adapter instance. This avoids loading all provider code upfront and
 * keeps startup fast.
 *
 * @returns Map of provider ID to async factory function that creates an adapter instance
 *
 * @example
 * ```typescript
 * import { discoverProviders } from '@cleocode/adapters';
 *
 * const providers = await discoverProviders();
 * const factory = providers.get('claude-code');
 * if (factory) {
 *   const adapter = await factory();
 * }
 * ```
 */
export async function discoverProviders(): Promise<Map<string, () => Promise<unknown>>> {
  const providers = new Map<string, () => Promise<unknown>>();

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

  providers.set('pi', async () => {
    const { PiAdapter } = await import('./providers/pi/index.js');
    return new PiAdapter();
  });

  return providers;
}
