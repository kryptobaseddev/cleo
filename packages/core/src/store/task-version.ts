/**
 * Optimistic-concurrency primitives for task rows (T12503).
 *
 * A task's version is its `updatedAt` timestamp, falling back to `createdAt`
 * for a row that has never been updated. Two rules make that timestamp usable
 * as a version:
 *
 *  1. Every guarded write computes its new `updatedAt` INSIDE the write
 *     transaction with {@link nextTaskVersion}, which is strictly greater than
 *     the stored value. Two writes in the same millisecond therefore never
 *     leave the row at a version a stale reader already holds (no ABA).
 *  2. The comparison ({@link assertTaskVersion}) runs after `BEGIN IMMEDIATE`
 *     holds the database write lock, so no other process can commit between
 *     the check and the write.
 *
 * `withWriteRetry` only absorbs `SQLITE_BUSY`; it cannot detect a lost update.
 * These helpers are what turn a stale read-modify-write into a typed
 * `E_CONFLICT` instead of a silent overwrite.
 *
 * @task T12503
 * @epic T12497
 */

import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../errors.js';

/** The minimal row shape that carries a task version. */
export interface TaskVersionSource {
  /** Last-update timestamp (ISO 8601), or null/undefined for a never-updated row. */
  updatedAt?: string | null;
  /** Creation timestamp (ISO 8601); the version of a never-updated row. */
  createdAt?: string | null;
}

/**
 * Return the version of a task row: `updatedAt`, else `createdAt`, else `''`.
 *
 * @param row - A task or task row.
 * @returns The opaque version string callers pass back as `expectedUpdatedAt`.
 * @example
 * ```ts
 * const version = taskVersion(await accessor.loadSingleTask('T1'));
 * ```
 */
export function taskVersion(row: TaskVersionSource | null | undefined): string {
  return row?.updatedAt ?? row?.createdAt ?? '';
}

/**
 * Compute the `updatedAt` for a write on top of `current`: now, or 1 ms past
 * the stored version when the clock has not moved past it.
 *
 * @param current - The row as read inside the write transaction.
 * @param now - The candidate timestamp; defaults to the current time.
 * @returns An ISO timestamp strictly greater than the stored version.
 * @example
 * ```ts
 * row.updatedAt = nextTaskVersion(current);
 * ```
 */
export function nextTaskVersion(
  current: TaskVersionSource | null | undefined,
  now?: string,
): string {
  const candidate = now ?? new Date().toISOString();
  const stored = Date.parse(taskVersion(current));
  if (Number.isNaN(stored)) return candidate;
  const next = Date.parse(candidate);
  if (!Number.isNaN(next) && next > stored) return candidate;
  return new Date(stored + 1).toISOString();
}

/**
 * Throw `E_CONFLICT` when the caller's expected version no longer matches.
 *
 * A no-op when `expectedUpdatedAt` is undefined, which preserves the
 * last-writer-wins behaviour of unguarded callers.
 *
 * @param taskId - Task being written.
 * @param current - The row as read inside the write transaction.
 * @param expectedUpdatedAt - The version the caller read, if it supplied one.
 * @throws {CleoError} `ExitCode.VERSION_CONFLICT` (LAFS `E_CONFLICT`) with
 *   `details.expected` = the caller's version and `details.actual` = the
 *   current version.
 * @example
 * ```ts
 * assertTaskVersion('T1', current, guard?.expectedUpdatedAt);
 * ```
 */
export function assertTaskVersion(
  taskId: string,
  current: TaskVersionSource,
  expectedUpdatedAt: string | undefined,
): void {
  if (expectedUpdatedAt === undefined) return;
  const currentVersion = taskVersion(current);
  if (currentVersion === expectedUpdatedAt) return;
  throw new CleoError(
    ExitCode.VERSION_CONFLICT,
    `Task ${taskId} changed since it was read (expected version ${expectedUpdatedAt}, current ${currentVersion})`,
    {
      fix: `Re-read the task (cleo show ${taskId}) and retry with --expected-updated-at ${currentVersion}`,
      details: {
        field: 'updatedAt',
        expected: expectedUpdatedAt,
        actual: currentVersion,
        currentVersion,
      },
    },
  );
}
