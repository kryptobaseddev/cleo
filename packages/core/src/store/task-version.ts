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
 *     the check and the write. The field-level chokepoint
 *     (`updateTaskFields`) additionally puts the version in the UPDATE's
 *     WHERE clause, so a guarded write is a single compare-and-set statement.
 *
 * A conflict is raised by {@link taskConflictError}: `E_CONFLICT` with the
 * current version, the fields that differ from the caller's read, the stored
 * values to merge against, and a `--if-match` retry hint.
 *
 * `withWriteRetry` only absorbs `SQLITE_BUSY`; it cannot detect a lost update.
 * These helpers are what turn a stale read-modify-write into a typed
 * `E_CONFLICT` instead of a silent overwrite.
 *
 * @task T12503
 * @epic T12497
 */

import { isDeepStrictEqual } from 'node:util';
import type { Task, TaskConflictChange, TaskConflictDetails } from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
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

/** Longest JSON summary of one field value carried on a conflict error. */
const CONFLICT_VALUE_MAX = 200;

/** Most entries of `current.labels` / `current.depends` carried on a conflict error. */
const CONFLICT_LIST_MAX = 50;

/** Cut a string to {@link CONFLICT_VALUE_MAX} characters, marking the cut. */
function truncate(text: string): string {
  return text.length <= CONFLICT_VALUE_MAX ? text : `${text.slice(0, CONFLICT_VALUE_MAX - 1)}…`;
}

/** Fields never reported as "changed": the version itself. */
const CONFLICT_IGNORED_FIELDS: ReadonlySet<string> = new Set(['updatedAt']);

/** JSON of a field value for a conflict summary, truncated; `null` when absent. */
function summarizeValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const json = JSON.stringify(value);
  if (json === undefined) return null;
  return truncate(json);
}

/** Narrow a version source to a full task row. */
function isFullTask(row: Task | TaskVersionSource): row is Task {
  return 'id' in row && 'title' in row && 'status' in row;
}

/**
 * List the fields whose stored value differs from the caller's read.
 *
 * The version field (`updatedAt`) is never listed; an absent field and an
 * explicit `null` compare equal.
 *
 * @param baseline - The task as the caller read it.
 * @param current - The task as stored now.
 * @returns One entry per differing field, sorted by field name.
 * @example
 * ```ts
 * diffTaskFields(before, after); // [{ field: 'labels', was: '["a"]', now: '["a","b"]' }]
 * ```
 */
export function diffTaskFields(baseline: Task, current: Task): TaskConflictChange[] {
  // Values are heterogeneous task fields that are only compared and JSON-encoded.
  const was = new Map<string, unknown>(Object.entries(baseline));
  const now = new Map<string, unknown>(Object.entries(current));
  const fields = [...new Set([...was.keys(), ...now.keys()])].sort();
  const changes: TaskConflictChange[] = [];
  for (const field of fields) {
    if (CONFLICT_IGNORED_FIELDS.has(field)) continue;
    const before = was.get(field) ?? null;
    const after = now.get(field) ?? null;
    if (isDeepStrictEqual(before, after)) continue;
    changes.push({ field, was: summarizeValue(before), now: summarizeValue(after) });
  }
  return changes;
}

/**
 * Build the `E_CONFLICT` error for a stale task write.
 *
 * @param taskId - Task being written.
 * @param expectedUpdatedAt - The version the caller expected.
 * @param current - The row as stored now; a full task adds the merge summary.
 * @param baseline - The task as the caller read it, when the write path has it.
 * @returns A {@link CleoError} with `ExitCode.VERSION_CONFLICT` (LAFS
 *   `E_CONFLICT`), a fix hint, and {@link TaskConflictDetails} as `details`.
 * @example
 * ```ts
 * throw taskConflictError('T1', expected, await accessor.loadSingleTask('T1'), baseline);
 * ```
 */
export function taskConflictError(
  taskId: string,
  expectedUpdatedAt: string,
  current: Task | TaskVersionSource | null,
  baseline?: Task,
): CleoError {
  const currentVersion = taskVersion(current);
  const full = current !== null && isFullTask(current) ? current : null;
  const changes = full && baseline ? diffTaskFields(baseline, full) : [];
  const details: TaskConflictDetails = {
    field: 'updatedAt',
    expected: expectedUpdatedAt,
    actual: currentVersion,
    currentVersion,
    changedFields: changes.map((change) => change.field),
    changes,
    current: full
      ? {
          title: truncate(full.title),
          status: full.status,
          priority: full.priority,
          labels: (full.labels ?? []).slice(0, CONFLICT_LIST_MAX),
          labelsTotal: full.labels?.length ?? 0,
          depends: (full.depends ?? []).slice(0, CONFLICT_LIST_MAX),
          dependsTotal: full.depends?.length ?? 0,
          parentId: full.parentId ?? null,
        }
      : null,
  };
  const changed =
    details.changedFields.length > 0 ? ` Changed: ${details.changedFields.join(', ')}.` : '';
  return new CleoError(
    ExitCode.VERSION_CONFLICT,
    `Task ${taskId} changed since it was read (expected version ${expectedUpdatedAt}, current ${currentVersion}).${changed}`,
    {
      fix: `Re-read the task (cleo show ${taskId}), merge your change onto it, then retry with --if-match ${currentVersion}`,
      details: { ...details },
    },
  );
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
 * @param baseline - The task as the caller read it; enables the changed-field summary.
 * @throws {CleoError} `ExitCode.VERSION_CONFLICT` (LAFS `E_CONFLICT`) with
 *   {@link TaskConflictDetails} as `details`.
 * @example
 * ```ts
 * assertTaskVersion('T1', current, guard?.expectedUpdatedAt, guard?.baseline);
 * ```
 */
export function assertTaskVersion(
  taskId: string,
  current: Task | TaskVersionSource,
  expectedUpdatedAt: string | undefined,
  baseline?: Task,
): void {
  if (expectedUpdatedAt === undefined) return;
  if (taskVersion(current) === expectedUpdatedAt) return;
  throw taskConflictError(taskId, expectedUpdatedAt, current, baseline);
}
