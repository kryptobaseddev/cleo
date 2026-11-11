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

import { type SpawnSyncOptionsWithStringEncoding, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { DisposeWorktreeOptions } from '@cleocode/contracts';
import { computeProjectHash } from '@cleocode/paths';
import {
  AGENT_LEASE_MAX_LIFETIME_MS,
  readAgentLeasesForCleanup,
} from '../resources/agent-lease.js';

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

/** Canonical paths for process/worker ownership comparisons. */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Whether a path is this worktree or a directory inside it. */
function inside(root: string, path: string): boolean {
  const part = relative(canonical(root), canonical(path));
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

/**
 * Prove no process has a cwd or open file in a worktree. A missing tool,
 * restricted listing, warning, timeout or failed probe keeps the worktree.
 * lsof's documented empty-match exit is 1 with empty stdout and stderr.
 * @param worktreePath - Directory whose complete tree is checked.
 * @returns The reason to keep it, or null for a successful empty listing.
 */
export function worktreeProcessUse(worktreePath: string): string | null {
  const options: SpawnSyncOptionsWithStringEncoding = {
    encoding: 'utf8',
    timeout: 5_000,
    env: { ...process.env, LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  if (process.getuid?.() !== 0) {
    const help = spawnSync('lsof', ['-h'], options);
    if (
      help.error ||
      help.signal ||
      !`${help.stdout}${help.stderr}`.includes('Anyone can list all files')
    ) {
      return 'process usage probe unavailable: lsof cannot prove unrestricted process visibility';
    }
  }
  const result = spawnSync(
    'lsof',
    ['-nP', '+w', '-Fpn', '-x', 'f', '+D', canonical(worktreePath)],
    options,
  );
  if (
    result.error ||
    result.signal ||
    result.stderr.trim() !== '' ||
    (result.status !== 0 && result.status !== 1)
  ) {
    return 'process usage probe unavailable or incomplete';
  }
  if (result.stdout.trim() !== '') return 'a process has its cwd or an open file in the worktree';
  return result.status === 1 ? null : 'process usage probe returned an inconclusive empty success';
}

/**
 * The reaper's separate proof of inactivity. Task locks identify a spawner,
 * so they are never worker liveness evidence. Open worker records, live
 * session leases, or any unreadable source keep the checkout.
 * @param projectRoot - Owning project.
 * @param taskId - Terminal task that owns the checkout.
 * @param worktreePath - Checkout to protect.
 * @returns A fail-closed callback for the one disposal engine.
 */
export async function worktreeReaperInUseProbe(
  projectRoot: string,
  taskId: string,
  worktreePath: string,
): Promise<NonNullable<DisposeWorktreeOptions['inUse']>> {
  try {
    // T14440 (census AC3, round-5 design) — fail closed for foreign stores:
    // a removal is never authorized from a read that can be stale.
    //  - A WARM, OPEN binding for the exact store reads fresh (it sees this
    //    process's own WAL-resident writes) and opens nothing new: use it.
    //  - Otherwise OWN project: the normal accessor (fresh reads).
    //  - Otherwise foreign:
    //      · a `-wal` with nonzero size, or an unreadable store → keep with
    //        an explicit unknown reason;
    //      · otherwise the immutable read may answer 'not in use'.
    const { isOwnProjectStore, peekProjectTasksNative, projectStoreWalPending } = await import(
      '../store/sqlite.js'
    );
    const warm = peekProjectTasksNative(projectRoot);
    if (warm === null && !isOwnProjectStore(projectRoot)) {
      if (projectStoreWalPending(projectRoot)) {
        return () => 'unknown: store has uncommitted WAL or could not be read without writing';
      }
      const { listWorkerRecordsReadOnly } = await import('../orchestrate/worker-records.js');
      const workers = await listWorkerRecordsReadOnly(projectRoot, true);
      if (
        workers.some(
          (worker) =>
            worker.stoppedAt === null &&
            (worker.taskId === taskId || inside(worktreePath, worker.worktree)),
        )
      ) {
        return () => 'a worker record has not been closed';
      }
    } else {
      const { listWorkerRecords } = await import('../orchestrate/worker-records.js');
      const workers = await listWorkerRecords(projectRoot, true);
      if (
        workers.some(
          (worker) =>
            worker.stoppedAt === null &&
            (worker.taskId === taskId || inside(worktreePath, worker.worktree)),
        )
      ) {
        return () => 'a worker record has not been closed';
      }
    }
  } catch {
    return () => 'unknown: store has uncommitted WAL or could not be read without writing';
  }
  return () => {
    try {
      const now = Date.now();
      const leases = readAgentLeasesForCleanup();
      if (
        leases.some(
          (lease) =>
            ((lease.taskId === taskId && canonical(lease.projectRoot) === canonical(projectRoot)) ||
              inside(worktreePath, lease.projectRoot)) &&
            Math.min(lease.expiresAtMs, lease.takenAtMs + AGENT_LEASE_MAX_LIFETIME_MS) > now,
        )
      )
        return 'an agent-session lease is still live';
    } catch {
      return 'agent-session lease probe unavailable';
    }
    return worktreeProcessUse(worktreePath);
  };
}
