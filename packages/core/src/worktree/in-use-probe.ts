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
import {
  assessWorktreeLockHolder,
  probeProcess,
  readStableDeviceId,
  readWorktreeTaskLock,
  resolveWorktreeLockTtlMs,
} from '@cleocode/worktree';

/** A locally verified dead or recycled process is a crash; age alone is not proof. */
function crashed(record: Parameters<typeof assessWorktreeLockHolder>[0]): boolean {
  const assessment = assessWorktreeLockHolder(record, {
    now: Date.now(),
    ttlMs: resolveWorktreeLockTtlMs(),
    probe: probeProcess,
    deviceId: readStableDeviceId(),
  });
  return assessment.reason === 'pid-gone' || assessment.reason === 'pid-recycled';
}

/**
 * Whether a task's worktree lock proves its local worker has crashed.
 * Unreadable locks, remote holders and heartbeat expiry alone are inconclusive.
 */
export function worktreeTaskCrashed(projectRoot: string, taskId: string | null): boolean {
  if (taskId === null) return false;
  const record = readWorktreeTaskLock(computeProjectHash(projectRoot), taskId);
  return record !== null && crashed(record);
}

/**
 * The in-use probe for one worktree's task.
 *
 * @param readLock - The worktree package's lock reader (callers load it statically or lazily).
 * @param projectRoot - Project whose lock records are read.
 * @param taskId - The worktree's task, or `null`.
 * @param terminal - The stored task is done or cancelled; its old lock guards no active task.
 * @returns The probe, or `undefined` when no task owns the worktree.
 */
export function worktreeInUseProbe(
  readLock: typeof import('@cleocode/worktree').readWorktreeTaskLock,
  projectRoot: string,
  taskId: string | null,
  terminal = false,
): (() => string | null) | undefined {
  if (taskId === null) return undefined;
  return () => {
    const record = readLock(computeProjectHash(projectRoot), taskId);
    return record !== null && !terminal && !crashed(record) ? 'task lock held' : null;
  };
}
