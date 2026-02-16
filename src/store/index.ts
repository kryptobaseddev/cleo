/**
 * Unified store interface for CLEO V2 data access.
 * @epic T4454
 * @task T4457
 * @task T4645
 */

export { atomicWrite, atomicWriteJson, safeReadFile } from './atomic.js';
export { createBackup, listBackups, restoreFromBackup } from './backup.js';
export { acquireLock, isLocked, withLock } from './lock.js';
export type { ReleaseFn } from './lock.js';
export {
  readJson,
  readJsonRequired,
  saveJson,
  appendJsonl,
  computeChecksum,
} from './json.js';
export type { SaveJsonOptions } from './json.js';
export {
  createStoreProvider,
  detectStoreEngine,
} from './provider.js';
export type {
  StoreProvider,
  StoreEngine,
  TaskFilters,
  SessionFilters,
} from './provider.js';
export { createJsonStoreProvider } from './json-provider.js';

/**
 * Get a StoreProvider instance for the given working directory.
 * Convenience wrapper around createStoreProvider with auto-detection.
 *
 * @task T4645
 * @epic T4638
 */
export async function getStore(cwd?: string): Promise<import('./provider.js').StoreProvider> {
  const { createStoreProvider: create } = await import('./provider.js');
  return create(undefined, cwd);
}
