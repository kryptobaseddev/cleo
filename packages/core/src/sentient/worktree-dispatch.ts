/**
 * Worktree dispatch — unified native backend selector for the sentient loop.
 *
 * Provides a stable internal API surface for sentient tick + orchestrate.spawn
 * to invoke worktree operations. All dispatch routes through `@cleocode/worktree`
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
  WorktreeDisposalBlockers,
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
async function backend(): Promise<typeof import('@cleocode/worktree')> {
  return import('@cleocode/worktree');
}

// ---------------------------------------------------------------------------
// Public dispatch API
// ---------------------------------------------------------------------------

/**
 * Admit one worktree dependency install as a `scoped-build` run, without
 * waiting: the release on a grant, `null` when the budget is busy.
 *
 * @task T13524
 */
export async function admitWorktreeInstall(): Promise<(() => Promise<void>) | null> {
  const { governor } = await import('../resources/governor.js');
  try {
    const grant = await governor.acquire('scoped-build', { blocking: false });
    return grant.deferred ? null : () => grant.release();
  } catch {
    // Admission state cannot be kept here (sandbox, read-only home): fail open,
    // as every other governed run does.
    return async () => {};
  }
}

/**
 * Create a worktree for an agent task via the native backend.
 *
 * This is the canonical entry point for `orchestrate.spawn` to request a
 * worktree. It wraps `@cleocode/worktree.createWorktree` with the
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
  const { createProjectHookExecutor } = await import('../hooks/project-runner.js');
  const hookOptions = {
    ...options,
    projectHookExecutor: options.projectHookExecutor ?? createProjectHookExecutor(projectRoot),
  };
  // T13522: install the git shim before the worktree advertises strict protection.
  let withShim: CreateWorktreeOptions = hookOptions;
  if (!options.gitShim) {
    const { ensureGitShimDir } = await import('../spawn/branch-lock.js');
    const shim = ensureGitShimDir(projectRoot);
    withShim = { ...hookOptions, gitShim: { dir: shim.dir, installed: shim.installed } };
  }
  // T13524: admit the dependency install through the machine-wide heavy queue
  // (the same `scoped-build` class as `cleo run --class build`); a busy budget
  // defers it to the worker instead of blocking the spawn.
  const admitted =
    withShim.skipInstall || withShim.admitInstall
      ? withShim
      : { ...withShim, admitInstall: admitWorktreeInstall };
  return createWorktree(projectRoot, admitted);
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
export async function teardownWorktree(
  projectRoot: string,
  options: DestroyWorktreeOptions,
): Promise<DestroyWorktreeResult> {
  const mod = await backend();
  return mod.destroyWorktree(projectRoot, options);
}

/**
 * Surface a kept worktree as a `W_WORKTREE_KEPT` envelope warning, so
 * `cleo complete` and `cleo cancel` never keep one silently (T13701).
 *
 * @param taskId - The task whose worktree was kept.
 * @param kept - What still needs the worktree's files.
 * @param message - The disposal's explanation (names the path and blockers).
 *
 * @task T13701
 */
export async function warnWorktreeKept(
  taskId: string,
  kept: WorktreeDisposalBlockers,
  message: string | undefined,
): Promise<void> {
  const { pushWarning } = await import('../output.js');
  pushWarning({
    // @sync-invariant none:local-only a warning about a worktree on this machine's disk; never replicated
    code: 'W_WORKTREE_KEPT',
    message: message ?? `Worktree for ${taskId} kept: something still needs its files.`,
    context: { taskId, dependents: kept.dependents, evidence: kept.evidence },
  });
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
// worktree exports sync operations (destroyWorktree, listWorktrees,
// pruneWorktrees). We reference them via module-level cached imports so the
// tick loop can call them synchronously after the first async warm-up.
// ---------------------------------------------------------------------------

let _destroyWorktreeCache: typeof import('@cleocode/worktree').destroyWorktree | null = null;
let _listWorktreesCache: typeof import('@cleocode/worktree').listWorktrees | null = null;
let _pruneWorktreesCache: typeof import('@cleocode/worktree').pruneWorktrees | null = null;

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
  options: Parameters<typeof import('@cleocode/worktree').pruneWorktrees>[0],
): PruneWorktreesResult {
  if (!_pruneWorktreesCache) {
    return {
      removed: 0,
      removedPaths: [],
      quarantined: 0,
      quarantinedPaths: [],
      errors: [],
      gitPruneRan: false,
    };
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
