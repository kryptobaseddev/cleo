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

/**
 * Minimal manifest shape for provider discovery.
 *
 * @remarks
 * Each provider adapter ships a `manifest.json` in its directory under
 * `providers/`. The registry reads these at startup to populate the
 * adapter discovery surface. The shape is intentionally minimal -- only
 * the fields needed for dynamic loading and detection are required.
 */
export interface AdapterManifest {
  /** Unique provider identifier (e.g. "claude-code", "cursor"). */
  id: string;
  /** Human-readable display name for the provider. */
  name: string;
  /** Semantic version of the adapter. */
  version: string;
  /** Short description of what the provider integrates with. */
  description: string;
  /** Provider slug used for directory lookups. */
  provider: string;
  /** Relative path to the adapter's entry point module. */
  entryPoint: string;
  /** Capability flags declared by the adapter. */
  capabilities: Record<string, unknown>;
  /** Patterns used to auto-detect the provider in a project. */
  detectionPatterns: Array<{
    /** Detection strategy type (e.g. "file", "env"). */
    type: string;
    /** Glob or regex pattern to match. */
    pattern: string;
    /** Human-readable explanation of this detection rule. */
    description: string;
  }>;
}

/** Known provider IDs bundled with @cleocode/adapters. */
const PROVIDER_IDS = ['claude-code', 'opencode', 'cursor', 'pi'] as const;

/**
 * Get the manifests for all bundled provider adapters.
 *
 * @remarks
 * Scans the known provider directories for `manifest.json` files.
 * Providers whose manifests cannot be loaded (missing or malformed)
 * are silently skipped.
 *
 * @returns Array of adapter manifests for successfully loaded providers
 *
 * @example
 * ```typescript
 * import { getProviderManifests } from '@cleocode/adapters';
 *
 * const manifests = getProviderManifests();
 * for (const m of manifests) {
 *   console.log(`${m.id}: ${m.name} v${m.version}`);
 * }
 * ```
 */
export function getProviderManifests(): AdapterManifest[] {
  const manifests: AdapterManifest[] = [];
  const baseDir = resolve(dirname(fileURLToPath(import.meta.url)), 'providers');

  for (const providerId of PROVIDER_IDS) {
    try {
      const manifestPath = join(baseDir, providerId, 'manifest.json');
      const raw = readFileSync(manifestPath, 'utf-8');
      manifests.push(JSON.parse(raw) as AdapterManifest);
    } catch {
      // Skip providers whose manifests cannot be loaded
    }
  }

  return manifests;
}

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
