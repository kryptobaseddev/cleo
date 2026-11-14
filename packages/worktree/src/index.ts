/**
 * @cleocode/worktree — Native CLEO worktree backend SDK.
 *
 * Formalizes the scattered worktree logic from:
 *   - `packages/cant/src/worktree.ts`
 *   - `packages/core/src/spawn/branch-lock.ts`
 *   - `packages/core/src/sentient/baseline.ts` (integrated via dispatch)
 *   - `packages/core/src/sentient/merge.ts` (integrated via dispatch)
 *
 * Canonical worktree path layout per D029:
 *   `~/.local/share/cleo/worktrees/<projectHash>/<taskId>/`
 *
 * Native lift of worktrunk's two missing features (D030):
 *   1. Declarative hooks framework (post-create / post-start)
 *   2. `.cleo/worktree-include` glob pattern support
 *
 * Zero worktrunk dependency — all logic is CLEO-native.
 *
 * @packageDocumentation
 * @task T1161
 * @adr ADR-055
 */

// Re-export all contract types for consumers
export type {
  CreateWorktreeOptions,
  CreateWorktreeResult,
  DestroyWorktreeOptions,
  DestroyWorktreeResult,
  DisposeWorktreeOptions,
  DisposeWorktreeResult,
  ListWorktreesOptions,
  PruneWorktreesOptions,
  PruneWorktreesResult,
  WorktreeArchiveReceipt,
  WorktreeDependentsScan,
  WorktreeDisposalBlockers,
  WorktreeHook,
  WorktreeHookResult,
  WorktreeIncludePattern,
  WorktreeKeepMarker,
  WorktreeListEntry,
} from '@cleocode/contracts';
export type { CopyPathsOptions } from './copy-on-write.js';
export { copyPathsWithReflock } from './copy-on-write.js';
export {
  type AddTransientWorktreeOptions,
  addTransientWorktree,
  countUnmergedCommits,
  DEFAULT_GIT_TIMEOUT_MS,
  getGitRoot,
  gitSilent,
  gitSync,
  pruneWorktreeRegistry,
  removeTransientWorktree,
  unlockWorktree,
} from './git.js';
// NAPI bindings (sync, direct to Rust). The raw destroy is not exported:
// every disposal goes through `disposeWorktree` (T13924, arch gate 41).
export {
  integrateWorktree,
  provisionWorktree,
  provisionWorktree as napiProvisionWorktree,
  pruneWorktrees as napiPruneWorktrees,
  removeDir as napiRemoveDir,
} from './napi-binding.js';
export type { PartialWorktreeSignals, RecoveryResult } from './recovery.js';
export { detectPartialWorktree, recoverPartialWorktree } from './recovery.js';
export type { WorktreeAuditPayload } from './worktree-audit.js';
export {
  addWorktreeToSentinelIndex,
  appendWorktreeAuditLog,
  isCleoProvisionedWorktree,
  readWorktreeProvisioning,
  removeWorktreeFromSentinelIndex,
  resolveWorktreeIndexPath,
  WORKTREE_INDEX_RELATIVE_PATH,
  WORKTREE_LIFECYCLE_AUDIT_FILE,
} from './worktree-audit.js';
export { buildWorktreeEnvVars, createWorktree } from './worktree-create.js';
export {
  createWorktreeDependentsScan,
  describeDisposalBlockers,
  findDisposalBlockers,
  findUnrecoverableEvidence,
  findWorktreeDependents,
  guardWorktreeDisposal,
  keepMarkerPath,
  readKeepMarker,
} from './worktree-dependents.js';
export { destroyWorktree } from './worktree-destroy.js';
export {
  archiveWorktree,
  type CompareBudget,
  type DisposeOwnedWorktreeOptions,
  type DisposeOwnedWorktreeResult,
  /**
   * Remove a worktree only while the caller's lock token still holds the task
   * lock: token, exact path and branch are checked and the worktree removed
   * under the lock's mutex, then the lock is released with that token. A
   * re-entered or successor lock's worktree is always kept (T14407 · T14489).
   */
  disposeOwnedWorktree,
  disposeWorktree,
  isRegenerable,
  newCompareBudget,
  type UnprovenContentOptions,
  unpreservedCommits,
  unprovenContent,
} from './worktree-dispose.js';
export { runProjectWorktreeHooks, runWorktreeHooks } from './worktree-hooks.js';
export { applyIncludePatterns, loadWorktreeIncludePatterns } from './worktree-include.js';
export {
  listWorktrees,
  listWorktreesByProjectRoot,
  resolveWorktreeRoot,
} from './worktree-list.js';
export * from './worktree-locate.js';
export {
  type AcquireWorktreeTaskLockOptions,
  acquireWorktreeTaskLock,
  assessWorktreeLockHolder,
  DEFAULT_WORKTREE_LOCK_TTL_MS,
  heartbeatWorktreeTaskLock,
  isSameLockCaller,
  isWorktreeLockedError,
  type ProcessLiveness,
  type ProcessProbe,
  probeProcess,
  readProcessStartTime,
  readStableDeviceId,
  readWorktreeTaskLock,
  releaseWorktreeTaskLock,
  releaseWorktreeTaskLocksForSession,
  resolveWorktreeLockTtlMs,
  WORKTREE_LOCK_TTL_ENV,
  type WorktreeLockAssessment,
  type WorktreeLockedError,
} from './worktree-lock.js';
export type { MigrateWorktreeResult } from './worktree-migrate.js';
export {
  discoverParentProjectRoot,
  migrateAllWorktreeIdentities,
  migrateWorktreeIdentity,
} from './worktree-migrate.js';
export { configureWorktreePnpmStore, installWorktreeDependencies } from './worktree-pnpm.js';
export type { CoreWorktreeLeakResult, InstallStatus } from './worktree-preflight.js';
export {
  assertNoWorktreeConfigLeak,
  detectAndHealCoreWorktreeLeak,
  ensureWorktreeBuildReady,
} from './worktree-preflight.js';
export { buildGitAwarePrunePlan, pruneWorktrees } from './worktree-prune.js';
