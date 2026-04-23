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
// Backward-compatibility shim for callers of packages/cant/src/worktree.ts
export type {
  LegacyMergeResult,
  LegacyWorktreeConfig,
  LegacyWorktreeEntry,
  LegacyWorktreeHandle,
  LegacyWorktreeRequest,
} from './compat.js';
export {
  legacyCreateWorktree,
  legacyListWorktrees,
  legacyMergeWorktree,
  legacyResolveWorktreeRoot,
} from './compat.js';
export { createWorktree } from './worktree-create.js';
export { destroyWorktree } from './worktree-destroy.js';
export { runWorktreeHooks } from './worktree-hooks.js';
export { applyIncludePatterns, loadWorktreeIncludePatterns } from './worktree-include.js';
export {
  listWorktrees,
  listWorktreesByProjectRoot,
  resolveWorktreeRoot,
} from './worktree-list.js';
export { pruneWorktrees } from './worktree-prune.js';
