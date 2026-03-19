/**
 * Dynamic adapter loading utilities.
 *
 * Replaces the former static ADAPTER_REGISTRY with discovery-based loading.
 * Adapters are found via discoverAdapterManifests() and loaded dynamically
 * using each manifest's packagePath and entryPoint.
 *
 * Zero hardcoded adapter package names — everything derives from manifests.
 *
 * @task T5698
 */

import { join } from 'node:path';
import type { AdapterManifest, CLEOProviderAdapter } from '@cleocode/contracts';

/**
 * Validate that a loaded module export implements the CLEOProviderAdapter interface.
 * Checks for required methods and properties without relying on instanceof.
 */
export function isValidAdapter(adapter: unknown): adapter is CLEOProviderAdapter {
  if (adapter === null || typeof adapter !== 'object') return false;
  const obj = adapter as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    typeof obj.name === 'string' &&
    typeof obj.version === 'string' &&
    typeof obj.initialize === 'function' &&
    typeof obj.dispose === 'function' &&
    typeof obj.healthCheck === 'function' &&
    obj.capabilities !== null &&
    typeof obj.capabilities === 'object'
  );
}

/**
 * Dynamically load and instantiate an adapter from its manifest.
 *
 * Uses the manifest's packagePath to resolve the adapter module,
 * then looks for a `createAdapter()` factory or a default export class.
 *
 * @param manifest - The adapter manifest with a resolved packagePath
 * @returns A CLEOProviderAdapter instance
 * @throws If the module cannot be loaded or does not export a valid adapter
 */
export async function loadAdapterFromManifest(
  manifest: AdapterManifest,
): Promise<CLEOProviderAdapter> {
  const modulePath = join(manifest.packagePath, manifest.entryPoint);
  const adapterModule = await import(modulePath);

  // Prefer createAdapter() factory (all adapter packages export this)
  if (typeof adapterModule.createAdapter === 'function') {
    const adapter = adapterModule.createAdapter();
    if (isValidAdapter(adapter)) return adapter;
    throw new Error(`createAdapter() in ${manifest.id} did not return a valid CLEOProviderAdapter`);
  }

  // Fall back to default export (may be a class constructor)
  if (adapterModule.default) {
    const DefaultExport = adapterModule.default;
    if (typeof DefaultExport === 'function') {
      const adapter = new DefaultExport();
      if (isValidAdapter(adapter)) return adapter;
    } else if (isValidAdapter(DefaultExport)) {
      return DefaultExport;
    }
  }

  throw new Error(
    `Adapter module for ${manifest.id} does not export createAdapter() or a valid default`,
  );
}
