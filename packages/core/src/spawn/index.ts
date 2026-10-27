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
// Per-agent spawn identity (T11343 · Epic T11284)
export type { SpawnAgentIdentity, SpawnSessionResolution } from './agent-identity.js';
export {
  abandonSpawnSession,
  allocateSpawnSession,
  deriveAgentHandle,
  requireSpawnSession,
} from './agent-identity.js';
// Branch integration (T10862)
export { completeAgentWorktreeViaMerge, getDefaultBranch } from './branch-integration.js';
// Branch-lock engine (T1118, T1462, T1587, T1601)
export type { PruneWorktreeResult } from './branch-lock.js';
export {
  applyFsHarden,
  buildAgentEnv,
  buildWorktreeSpawnResult,
  createAgentWorktree,
  detectFsHardenCapabilities,
  ensureGitShimDir,
  getGitRoot,
  pruneOrphanedWorktrees,
  pruneWorktree,
  removeFsHarden,
  resolveAgentWorktreeRoot,
} from './branch-lock.js';
