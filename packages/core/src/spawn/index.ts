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
  initializeSpawnAdapters,
  SpawnAdapterRegistry,
  spawnRegistry,
} from './adapter-registry.js';
// Branch-lock engine (T1118, T1462, T1587, T1601)
export type { PruneWorktreeResult } from './branch-lock.js';
export {
  applyFsHarden,
  buildAgentEnv,
  buildWorktreeSpawnResult,
  completeAgentWorktree,
  completeAgentWorktreeViaMerge,
  createAgentWorktree,
  detectFsHardenCapabilities,
  ensureGitShimDir,
  getDefaultBranch,
  getGitRoot,
  pruneOrphanedWorktrees,
  pruneWorktree,
  removeFsHarden,
  resolveAgentWorktreeRoot,
} from './branch-lock.js';
