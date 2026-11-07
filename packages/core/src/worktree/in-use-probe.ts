/**
 * The in-use probe core hands the disposal engine (T13924): a CLEO task lock
 * record for the worktree's task means an agent may still be working in it.
 *
 * Its own module (T14274): the listing classifies through it and prune
 * disposes through it, and prune already imports the listing.
 *
 * @module
 * @task T14274
 */

import { computeProjectHash } from '@cleocode/paths';

/**
 * The in-use probe for one worktree's task.
 *
 * @param readLock - The worktree package's lock reader (callers load it statically or lazily).
 * @param projectRoot - Project whose lock records are read.
 * @param taskId - The worktree's task, or `null`.
 * @returns The probe, or `undefined` when no task owns the worktree.
 */
export function worktreeInUseProbe(
  readLock: typeof import('@cleocode/worktree').readWorktreeTaskLock,
  projectRoot: string,
  taskId: string | null,
): (() => string | null) | undefined {
  if (taskId === null) return undefined;
  return () =>
    readLock(computeProjectHash(projectRoot), taskId) !== null ? 'task lock held' : null;
}
