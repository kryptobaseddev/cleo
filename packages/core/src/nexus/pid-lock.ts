/**
 * A per-project, single-flight pid lock for NEXUS background work (T14010,
 * T14014): the reindex after a merge and the inline refresh each run at most
 * once at a time per project.
 *
 * The pid is written to a private file that is then hard-linked into place, so
 * a reader never sees an empty lock. A dead holder is cleared by renaming the
 * lock to a unique name and checking the renamed file still holds that dead
 * pid, so two clearers cannot both win: only one rename succeeds, and a
 * clearer that moved a live lock by mistake puts it back. An empty or
 * unparseable lock younger than {@link PID_LOCK_WRITE_GRACE_MS} counts as a
 * holder still writing it. Release removes the lock only when it holds the
 * releaser's pid.
 *
 * Code placed in `packages/core/` per Package-Boundary Check — verified against AGENTS.md.
 *
 * @module nexus/pid-lock
 * @task T14014
 */

import { randomUUID } from 'node:crypto';
import { linkSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';

/** A lock file younger than this with no readable pid is a holder still writing it. */
export const PID_LOCK_WRITE_GRACE_MS = 5_000;

/** Test seams: the pid to take the lock as, and how liveness is judged. */
export interface PidLockOptions {
  /** Pid written to the lock. @defaultValue process.pid */
  pid?: number;
  /** Whether a pid is alive. @defaultValue a signal-0 probe */
  isAlive?: (pid: number) => boolean;
}

/** Whether a process with this pid is alive. */
function probeAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The pid a lock file holds, or `null` when it is missing, empty or unparseable. */
function readPid(path: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(path, 'utf-8'), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Errno code of a filesystem error. */
function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/**
 * Take a pid lock atomically.
 *
 * @param lockPath - The lock file.
 * @param options - Test seams (pid, liveness).
 * @returns `null` when taken, or the pid of the live holder (`0` when unknown).
 * @example
 * ```ts
 * const holder = takePidLock(join(cleoDir, 'nexus-reindex.lock'));
 * if (holder === null) try { work(); } finally { releasePidLock(lockPath); }
 * ```
 */
export function takePidLock(lockPath: string, options: PidLockOptions = {}): number | null {
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? probeAlive;
  const mine = `${lockPath}.${pid}.${randomUUID()}`;
  writeFileSync(mine, String(pid));
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(mine, lockPath);
        return null;
      } catch (error) {
        if (code(error) !== 'EEXIST') throw error;
      }
      const holder = readPid(lockPath);
      if (holder === null) {
        let young = true;
        try {
          young = Date.now() - statSync(lockPath).mtimeMs < PID_LOCK_WRITE_GRACE_MS;
        } catch (error) {
          if (code(error) === 'ENOENT') continue;
          throw error;
        }
        if (young) return 0;
      } else if (isAlive(holder)) {
        return holder;
      }
      // Clear the dead (or abandoned empty) lock: rename it aside, then make
      // sure what was moved is the lock that was judged dead.
      const aside = `${lockPath}.stale.${randomUUID()}`;
      try {
        renameSync(lockPath, aside);
      } catch (error) {
        if (code(error) === 'ENOENT') continue; // another clearer moved it first
        throw error;
      }
      const moved = readPid(aside);
      if (moved !== holder && moved !== null && isAlive(moved)) {
        // A live lock replaced the dead one between the read and the rename: put it back.
        try {
          linkSync(aside, lockPath);
        } catch (error) {
          if (code(error) !== 'EEXIST') throw error;
        }
        rmSync(aside, { force: true });
        return moved;
      }
      rmSync(aside, { force: true });
    }
    return 0;
  } finally {
    rmSync(mine, { force: true });
  }
}

/**
 * Release a pid lock taken by {@link takePidLock}: removed only when it still
 * holds this pid, so a lock someone else took over is left alone.
 *
 * @param lockPath - The lock file.
 * @param pid - The holder releasing it. @defaultValue process.pid
 */
export function releasePidLock(lockPath: string, pid: number = process.pid): void {
  if (readPid(lockPath) === pid) rmSync(lockPath, { force: true });
}
