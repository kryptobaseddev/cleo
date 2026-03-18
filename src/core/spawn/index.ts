/**
 * Spawn core module — barrel export.
 *
 * Re-exports spawn adapter registry and utilities from the core layer.
 *
 * @task T5709
 * @epic T5701
 */

export type { SpawnCapability } from './adapter-registry.js';
export {
  getProvidersWithSpawnCapability,
  hasParallelSpawnProvider,
  initializeDefaultAdapters,
  SpawnAdapterRegistry,
  spawnRegistry,
} from './adapter-registry.js';
