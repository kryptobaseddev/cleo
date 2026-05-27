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
  ListWorktreesOptions,
  PruneWorktreesOptions,
  PruneWorktreesResult,
  WorktreeHook,
  WorktreeHookResult,
  WorktreeIncludePattern,
  WorktreeListEntry,
} from '@cleocode/contracts';
export type { CopyPathsOptions } from './copy-on-write.js';
export { copyPathsWithReflock } from './copy-on-write.js';
export {
  type AddTransientWorktreeOptions,
  addTransientWorktree,
  DEFAULT_GIT_TIMEOUT_MS,
  removeTransientWorktree,
} from './git.js';
export type { PartialWorktreeSignals, RecoveryResult } from './recovery.js';
export { detectPartialWorktree, recoverPartialWorktree } from './recovery.js';
export type { WorktreeAuditPayload } from './worktree-audit.js';
export {
  addWorktreeToSentinelIndex,
  appendWorktreeAuditLog,
  removeWorktreeFromSentinelIndex,
  resolveWorktreeIndexPath,
  WORKTREE_INDEX_RELATIVE_PATH,
  WORKTREE_LIFECYCLE_AUDIT_FILE,
} from './worktree-audit.js';
export { createWorktree } from './worktree-create.js';
export { destroyWorktree } from './worktree-destroy.js';
export { runWorktreeHooks } from './worktree-hooks.js';
export { applyIncludePatterns, loadWorktreeIncludePatterns } from './worktree-include.js';
export { installWorktreeDependencies } from './worktree-pnpm.js';
export {
  listWorktrees,
  listWorktreesByProjectRoot,
  resolveWorktreeRoot,
} from './worktree-list.js';
export { pruneWorktrees } from './worktree-prune.js';
