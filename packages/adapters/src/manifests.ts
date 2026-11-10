/** Bundled manifest discovery, independent of provider runtime imports. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdapterManifest } from '@cleocode/contracts';

export type { AdapterManifest } from '@cleocode/contracts';

/**
 * Get the manifests for all bundled provider adapters.
 *
 * @remarks
 * Reads shipped source manifests and resolves entry points beside this module,
 * so source tests and installed JavaScript use the same discovery path.
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
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const manifestsDir = resolve(moduleDir, '..', 'src', 'providers');
  if (!existsSync(manifestsDir)) return [];

  for (const providerId of readdirSync(manifestsDir)) {
    try {
      const manifestPath = join(manifestsDir, providerId, 'manifest.json');
      const raw = readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(raw) as AdapterManifest;
      manifests.push({
        ...manifest,
        packagePath: resolve(moduleDir, 'providers', providerId),
        entryPoint: 'index.js',
      });
    } catch {
      // Skip providers whose manifests cannot be loaded
    }
  }

  return manifests;
}
