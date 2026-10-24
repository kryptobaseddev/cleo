/**
 * A per-project, single-flight pid lock for NEXUS background work (T14010,
 * T14014): the reindex after a merge and the inline refresh each run at most
 * once at a time per project.
 *
 * The pid is written to a private file that is then hard-linked into place, so
 * a reader never sees an empty lock. A lock whose pid is dead is cleared once;
 * an empty or unparseable lock younger than {@link PID_LOCK_WRITE_GRACE_MS}
 * counts as a holder still writing it.
 *
 * Code placed in `packages/core/` per Package-Boundary Check — verified against AGENTS.md.
 *
 * @module nexus/pid-lock
 * @task T14014
 */

import { linkSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';

/** A lock file younger than this with no readable pid is a holder still writing it. */
export const PID_LOCK_WRITE_GRACE_MS = 5_000;

/** Whether a process with this pid is alive. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Take a pid lock atomically.
 *
 * @param lockPath - The lock file.
 * @returns `null` when taken, or the pid of the live holder (`0` when unknown).
 * @example
 * ```ts
 * const holder = takePidLock(join(cleoDir, 'nexus-reindex.lock'));
 * if (holder === null) try { work(); } finally { releasePidLock(lockPath); }
 * ```
 */
export function takePidLock(lockPath: string): number | null {
  const mine = `${lockPath}.${process.pid}`;
  writeFileSync(mine, String(process.pid));
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(mine, lockPath);
        return null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const holder = Number.parseInt(readFileSync(lockPath, 'utf-8'), 10);
        if (Number.isInteger(holder) && holder > 0) {
          if (alive(holder)) return holder;
        } else if (Date.now() - statSync(lockPath).mtimeMs < PID_LOCK_WRITE_GRACE_MS) {
          return 0;
        }
        rmSync(lockPath, { force: true });
      }
    }
    return 0;
  } finally {
    rmSync(mine, { force: true });
  }
}

/**
 * Release a pid lock taken by {@link takePidLock}.
 *
 * @param lockPath - The lock file.
 */
export function releasePidLock(lockPath: string): void {
  rmSync(lockPath, { force: true });
}
