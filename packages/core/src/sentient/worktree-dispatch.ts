/**
 * Worktree dispatch — unified native backend selector for the sentient loop.
 *
 * Provides a stable internal API surface for sentient tick + orchestrate.spawn
 * to invoke worktree operations. All dispatch routes through `@cleocode/worktree-backend`
 * (native implementation — zero worktrunk dependency per D030).
 *
 * Usage from `cleo sentient tick`:
 * ```ts
 * import { pruneWorktreesForProject } from './worktree-dispatch.js';
 * await pruneWorktreesForProject(projectRoot, activeTasks);
 * ```
 *
 * Usage from `orchestrate.spawn`:
 * ```ts
 * import { spawnWorktree } from './worktree-dispatch.js';
 * const result = await spawnWorktree(projectRoot, { taskId, hooks });
 * ```
 *
 * @task T1161
 * @adr ADR-055
 */

import type {
  CreateWorktreeOptions,
  CreateWorktreeResult,
  DestroyWorktreeOptions,
  DestroyWorktreeResult,
  ListWorktreesOptions,
  PruneWorktreesResult,
  WorktreeListEntry,
} from '@cleocode/contracts';

// ---------------------------------------------------------------------------
// Lazy import helper
// ---------------------------------------------------------------------------

/**
 * Lazy-import the worktree backend to keep the sentient bundle lean and to
 * avoid circular dependency at load time.
 *
 * @internal
 */
async function backend(): Promise<typeof import('@cleocode/worktree-backend')> {
  return import('@cleocode/worktree-backend');
}

// ---------------------------------------------------------------------------
// Public dispatch API
// ---------------------------------------------------------------------------

/**
 * Create a worktree for an agent task via the native backend.
 *
 * This is the canonical entry point for `orchestrate.spawn` to request a
 * worktree. It wraps `@cleocode/worktree-backend.createWorktree` with the
 * uniform dispatch contract.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param options - Create options including taskId and optional hooks.
 * @returns Creation result with env vars, preamble, and hook results.
 *
 * @task T1161
 */
export async function spawnWorktree(
  projectRoot: string,
  options: CreateWorktreeOptions,
): Promise<CreateWorktreeResult> {
  const { createWorktree } = await backend();
  return createWorktree(projectRoot, options);
}

/**
 * Destroy a worktree for a completed task via the native backend.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param options - Destroy options including taskId.
 * @returns Destruction result with cleanup details.
 *
 * @task T1161
 */
export function teardownWorktree(
  projectRoot: string,
  options: DestroyWorktreeOptions,
): DestroyWorktreeResult {
  // Import synchronously via dynamic require equivalent pattern.
  // For ESM we pre-require the module. Since this runs in Node.js ≥ 24,
  // we use the synchronous workaround via a wrapper.
  // NOTE: destroyWorktree is sync — wrap with a sync import here.
  // Since this is used in a sync context from tick, we use a synchronous shim.
  const destroyWorktreeFn = _syncDestroyWorktree;
  return destroyWorktreeFn(projectRoot, options);
}

/**
 * List worktrees scoped to a project via the native backend.
 *
 * @param options - Optional project hash filter.
 * @returns Array of worktree list entries.
 *
 * @task T1161
 */
export function listProjectWorktrees(options: ListWorktreesOptions = {}): WorktreeListEntry[] {
  return _syncListWorktrees(options);
}

/**
 * Prune orphaned worktrees for a project via the native backend.
 *
 * Called by `cleo sentient tick` every N ticks. Active task IDs are passed
 * to preserve worktrees that are still in use.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param activeTaskIds - Set of task IDs whose worktrees should be preserved.
 * @returns Prune result with removed paths and error list.
 *
 * @task T1161
 */
export function pruneWorktreesForProject(
  projectRoot: string,
  activeTaskIds: Set<string>,
): PruneWorktreesResult {
  return _syncPruneWorktrees({ projectRoot, preserveTaskIds: activeTaskIds, gitPrune: true });
}

// ---------------------------------------------------------------------------
// Synchronous shims for operations used from sync sentient tick context.
//
// worktree-backend exports sync operations (destroyWorktree, listWorktrees,
// pruneWorktrees). We reference them via module-level cached imports so the
// tick loop can call them synchronously after the first async warm-up.
// ---------------------------------------------------------------------------

let _destroyWorktreeCache: typeof import('@cleocode/worktree-backend').destroyWorktree | null =
  null;
let _listWorktreesCache: typeof import('@cleocode/worktree-backend').listWorktrees | null = null;
let _pruneWorktreesCache: typeof import('@cleocode/worktree-backend').pruneWorktrees | null = null;

/**
 * Synchronous wrapper for destroyWorktree.
 *
 * The first call will throw if the module hasn't been warmed up via
 * `warmupWorktreeBackend()`. In practice, the sentient daemon calls
 * `warmupWorktreeBackend()` during initialization.
 *
 * @internal
 */
function _syncDestroyWorktree(
  projectRoot: string,
  options: DestroyWorktreeOptions,
): DestroyWorktreeResult {
  if (!_destroyWorktreeCache) {
    throw new Error(
      '[worktree-dispatch] destroyWorktree called before warmupWorktreeBackend(). ' +
        'Call warmupWorktreeBackend() during daemon initialization.',
    );
  }
  return _destroyWorktreeCache(projectRoot, options);
}

/**
 * Synchronous wrapper for listWorktrees.
 * @internal
 */
function _syncListWorktrees(options: ListWorktreesOptions): WorktreeListEntry[] {
  if (!_listWorktreesCache) {
    return []; // Graceful degradation before warmup.
  }
  return _listWorktreesCache(options);
}

/**
 * Synchronous wrapper for pruneWorktrees.
 * @internal
 */
function _syncPruneWorktrees(
  options: Parameters<typeof import('@cleocode/worktree-backend').pruneWorktrees>[0],
): PruneWorktreesResult {
  if (!_pruneWorktreesCache) {
    return { removed: 0, removedPaths: [], errors: [], gitPruneRan: false };
  }
  return _pruneWorktreesCache(options);
}

/**
 * Pre-warm the worktree backend module so synchronous operations are
 * available for the sentient tick loop.
 *
 * Call once during daemon initialization (before the first tick). Safe to
 * call multiple times — subsequent calls are no-ops.
 *
 * @task T1161
 */
export async function warmupWorktreeBackend(): Promise<void> {
  if (_destroyWorktreeCache) return; // Already warmed up.

  const mod = await backend();
  _destroyWorktreeCache = mod.destroyWorktree;
  _listWorktreesCache = mod.listWorktrees;
  _pruneWorktreesCache = mod.pruneWorktrees;
}
