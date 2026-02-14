/**
 * File locking using proper-lockfile.
 * Prevents concurrent modifications to CLEO data files.
 * @epic T4454
 * @task T4457
 */

import lockfile from 'proper-lockfile';
import { CleoError } from '../core/errors.js';
import { ExitCode } from '../types/exit-codes.js';

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
  options?: { stale?: number; retries?: number },
): Promise<ReleaseFn> {
  try {
    const release = await lockfile.lock(filePath, {
      ...DEFAULT_LOCK_OPTIONS,
      ...(options?.stale !== undefined && { stale: options.stale }),
      ...(options?.retries !== undefined && {
        retries: {
          ...DEFAULT_LOCK_OPTIONS.retries,
          retries: options.retries,
        },
      }),
    });
    return release;
  } catch (err) {
    throw new CleoError(
      ExitCode.LOCK_TIMEOUT,
      `Failed to acquire lock: ${filePath}`,
      {
        fix: `Another process may be writing to this file. Wait and retry.`,
        cause: err,
      },
    );
  }
}

/**
 * Check if a file is currently locked.
 */
export async function isLocked(filePath: string): Promise<boolean> {
  try {
    return await lockfile.check(filePath, { realpath: false });
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
