/**
 * Worker isolation policy for spawns (T14358, epic T14351).
 *
 * `orchestrateSpawn` and `orchestrateSpawnExecute` both provision a worktree
 * before an agent runs. {@link resolveIsolation} is the one place that decides
 * what a failed provision means: refuse the spawn, or run the agent in the
 * project root without isolation.
 *
 * @task T14358
 * @epic T14351
 */

import { isWorktreeLockedError } from '@cleocode/worktree';
import { getConfigValue } from '../config/registry.js';

/**
 * Outcome of {@link resolveIsolation}.
 *
 * - `isolated`: the worktree was provisioned; `result` is what the provision
 *   callback returned.
 * - `refused`: provisioning failed and the spawn must not run.
 * - `project-root`: provisioning failed and the caller may run the agent in
 *   the project root without isolation (only when `failClosed` is false).
 *
 * @typeParam T - The provision callback's result.
 */
export type IsolationResolution<T> =
  | { readonly kind: 'isolated'; readonly result: T }
  | { readonly kind: 'refused'; readonly error: unknown }
  | { readonly kind: 'project-root'; readonly error: unknown };

/** Options for {@link resolveIsolation}. */
export interface ResolveIsolationOptions {
  /**
   * When true, a failed provision refuses the spawn. When false, it falls
   * back to the project root, except for a worktree held by a live holder
   * (T12506), which always refuses.
   */
  readonly failClosed: boolean;
}

/**
 * Provision a spawn's worktree and decide what a failure means.
 *
 * A {@link import('@cleocode/worktree').WorktreeLockedError} always refuses:
 * running in the project root would put a second agent on the same task.
 *
 * @param provision - Provisions the worktree; a throw is a failed provision.
 * @param opts - The isolation policy for this spawn.
 * @returns The provision result, or the failure with the decision.
 *
 * @example
 * ```typescript
 * const iso = await resolveIsolation(() => spawnWorktree(root, { taskId }), {
 *   failClosed: await isLeadWorkerV1Enabled(root),
 * });
 * if (iso.kind === 'refused') return refuse(iso.error);
 * ```
 *
 * @task T14358
 */
export async function resolveIsolation<T>(
  provision: () => Promise<T>,
  opts: ResolveIsolationOptions,
): Promise<IsolationResolution<T>> {
  try {
    return { kind: 'isolated', result: await provision() };
  } catch (error) {
    if (opts.failClosed || isWorktreeLockedError(error)) return { kind: 'refused', error };
    return { kind: 'project-root', error };
  }
}

/**
 * Read `orchestrate.leadWorker.v1` from the merged config cascade.
 *
 * An unreadable config reads as off, the flag's default (T14356).
 *
 * @param projectRoot - Project root whose config cascade is read.
 * @returns True only when the flag is set to `true`.
 *
 * @task T14358
 */
export async function isLeadWorkerV1Enabled(projectRoot: string): Promise<boolean> {
  try {
    return (await getConfigValue('orchestrate.leadWorker.v1', { projectRoot })) === true;
  } catch {
    return false;
  }
}
