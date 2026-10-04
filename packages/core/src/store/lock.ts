/**
 * File locking using proper-lockfile.
 * Prevents concurrent modifications to CLEO data files.
 * @epic T4454
 * @task T4457
 */

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
  options?: { stale?: number; retries?: number },
): Promise<T> {
  const release = await acquireLock(filePath, options);
  try {
    return await fn();
  } finally {
    await release();
  }
}
