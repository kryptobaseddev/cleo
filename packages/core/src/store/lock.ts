/**
 * File locking using proper-lockfile.
 * Prevents concurrent modifications to CLEO data files.
 * @epic T4454
 * @task T4457
 */

import * as fs from 'node:fs';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import lockfile from 'proper-lockfile';
import { CleoError } from '../errors.js';

/** Default lock options. */
const DEFAULT_LOCK_OPTIONS = {
  retries: {
    retries: 3,
    minTimeout: 100,
    maxTimeout: 1000,
    factor: 2,
  },
  stale: 10_000,
  realpath: false,
};

/** A release function returned by acquireLock. */
export type ReleaseFn = () => Promise<void>;

/**
 * Acquire an exclusive lock on a file.
 * Returns a release function that must be called when done.
 */
export async function acquireLock(
  filePath: string,
  options?: { stale?: number; retries?: number; onCompromised?: (err: Error) => void },
): Promise<ReleaseFn> {
  try {
    const release = await lockfile.lock(filePath, {
      ...DEFAULT_LOCK_OPTIONS,
      ...(options?.stale !== undefined && { stale: options.stale }),
      ...(options?.onCompromised !== undefined && { onCompromised: options.onCompromised }),
      ...(options?.retries !== undefined && {
        retries: {
          ...DEFAULT_LOCK_OPTIONS.retries,
          retries: options.retries,
        },
      }),
    });
    return release;
  } catch (err) {
    throw new CleoError(ExitCode.LOCK_TIMEOUT, `Failed to acquire lock: ${filePath}`, {
      fix: `Another process may be writing to this file. Wait and retry.`,
      cause: err,
    });
  }
}

/**
 * A held lock that can be released, or abandoned when it may no longer be
 * ours (T13299).
 */
export interface AbandonableLock {
  /** Release the lock: stop refreshing it and remove its directory. */
  release: ReleaseFn;
  /**
   * Stop holding the lock WITHOUT removing its directory: for a lock that was
   * lost or outlasted its stale window, which another process may have taken
   * since. proper-lockfile's release and its exit hook remove the directory
   * without checking who owns it; after `abandon` neither touches it. A
   * directory that was still ours is already stale, so the next taker
   * reclaims it. Never throws.
   */
  abandon: ReleaseFn;
}

/**
 * {@link acquireLock}, returning a lock that can also be abandoned (see
 * {@link AbandonableLock}). The lock's file operations go through node's fs,
 * with the directory removal skipped once the lock is abandoned.
 *
 * @param filePath - The file to lock (the lock is `<filePath>.lock`).
 * @param options - As for {@link acquireLock}.
 * @returns The held lock.
 * @throws CleoError (LOCK_TIMEOUT) when the lock cannot be acquired.
 * @task T13299
 */
export async function acquireAbandonableLock(
  filePath: string,
  options?: { stale?: number; retries?: number; onCompromised?: (err: Error) => void },
): Promise<AbandonableLock> {
  let abandoned = false;
  const guardedFs = {
    ...fs,
    rmdir(target: fs.PathLike, cb: (err: NodeJS.ErrnoException | null) => void): void {
      if (abandoned) {
        cb(null);
        return;
      }
      fs.rmdir(target, cb);
    },
    rmdirSync(target: fs.PathLike): void {
      if (!abandoned) fs.rmdirSync(target);
    },
  };
  let release: ReleaseFn;
  try {
    release = await lockfile.lock(filePath, {
      ...DEFAULT_LOCK_OPTIONS,
      fs: guardedFs,
      ...(options?.stale !== undefined && { stale: options.stale }),
      ...(options?.onCompromised !== undefined && { onCompromised: options.onCompromised }),
      ...(options?.retries !== undefined && {
        retries: { ...DEFAULT_LOCK_OPTIONS.retries, retries: options.retries },
      }),
    });
  } catch (err) {
    // @sync-invariant none:local-only a file lock held by another local process; never replicated
    throw new CleoError(ExitCode.LOCK_TIMEOUT, `Failed to acquire lock: ${filePath}`, {
      fix: `Another process may be writing to this file. Wait and retry.`,
      cause: err,
    });
  }
  return {
    release,
    abandon: async () => {
      abandoned = true;
      try {
        await release();
      } catch {
        // already released as compromised: nothing is held
      }
    },
  };
}

/**
 * Check if a file is currently locked.
 *
 * @param filePath - The locked file.
 * @param options - `stale` must match the holder's `stale` (ms): a holder
 *   refreshes its lock every `stale / 2`, so checking with a shorter window
 *   reports a live long-running holder as unlocked.
 */
export async function isLocked(filePath: string, options?: { stale?: number }): Promise<boolean> {
  try {
    return await lockfile.check(filePath, {
      realpath: false,
      ...(options?.stale !== undefined && { stale: options.stale }),
    });
  } catch {
    return false;
  }
}

/**
 * Execute a function while holding an exclusive lock on a file.
 * The lock is automatically released when the function completes (or throws).
 */
export async function withLock<T>(
  filePath: string,
  fn: () => Promise<T>,
  options?: { stale?: number; retries?: number; onCompromised?: (err: Error) => void },
): Promise<T> {
  const release = await acquireLock(filePath, options);
  try {
    return await fn();
  } finally {
    await release();
  }
}

/** The compromise state of one long-held lock ({@link lockCompromiseTracker}). */
export interface LockCompromiseTracker {
  /** Pass as `onCompromised`: records the loss instead of throwing from a timer. */
  readonly onCompromised: (err: Error) => void;
  /** Why the holder lost the lock (another process took it as stale), or null. */
  readonly reason: () => string | null;
}

/**
 * Track whether a long-held lock was compromised (T12785). proper-lockfile
 * refreshes a held lock every `stale / 2` from a timer; a holder whose event
 * loop is blocked longer than `stale` (one long synchronous transaction) can
 * have the lock taken by another process, and the default `onCompromised`
 * then throws from that timer, an uncaught exception. The tracker records the
 * loss instead, so the holder can stop at its next safe point and roll back.
 */
export function lockCompromiseTracker(): LockCompromiseTracker {
  let lost: string | null = null;
  return {
    onCompromised: (err) => {
      lost ??= err.message || 'lock compromised';
    },
    reason: () => lost,
  };
}
