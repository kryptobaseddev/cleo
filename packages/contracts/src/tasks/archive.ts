/**
 * Typed archive-reason enum for task archival writes (contracts SSoT).
 *
 * Promotes the `archiveReason` literal-string type into a Zod-validated
 * `z.enum` so every package — core/store, cleo CLI, dispatch, migration
 * tooling — references a single canonical truth. The DB CHECK constraint
 * (T1408 migration `20260424000000_t1408-archive-reason-enum`) enforces
 * the same six values at the SQLite layer; this contract enforces them
 * at the TypeScript and runtime-validation layer.
 *
 * Values (CANONICAL — must match the migration):
 *  - `verified`            — task reached `status='done'` AND verification
 *                            gates passed. Trustworthy completion.
 *  - `reconciled`          — closure was reconciled by an audit/repair pass
 *                            (BRAIN reconciliation, audit lineage, etc.).
 *  - `superseded`          — closed because a newer task replaces it
 *                            (typed merge / dedup outcome).
 *  - `shadowed`            — closed because a duplicate or shadow record
 *                            exists; this row is no longer authoritative.
 *  - `cancelled`           — task reached `status='cancelled'` (verification
 *                            irrelevant for cancellations).
 *  - `completed-unverified` — TOMBSTONE. Closure happened but verification
 *                            was never run, was incomplete, or failed.
 *                            ONLY migration backfill paths are permitted to
 *                            write this value; new code that attempts to
 *                            stamp it MUST throw {@link ArchiveReasonTombstoneError}.
 *
 * @epic T1407
 * @task T1409
 * @see packages/core/src/store/tasks-schema.ts — DB CHECK constraint
 * @see packages/core/src/tasks/archive.ts — derivation logic
 */

import { z } from 'zod';

/**
 * Canonical Zod enum for the six valid `archiveReason` values.
 *
 * Use `ArchiveReason.enum.<value>` to reference a literal in code, or
 * `ArchiveReason.parse(x)` to validate at a trust boundary.
 *
 * @example
 * ```ts
 * import { ArchiveReason } from '@cleocode/contracts';
 *
 * // Reference a literal:
 * const reason = ArchiveReason.enum.verified;
 *
 * // Validate untrusted input:
 * const safe = ArchiveReason.parse(externalInput);
 * ```
 */
export const ArchiveReason = z.enum([
  'verified',
  'reconciled',
  'superseded',
  'shadowed',
  'cancelled',
  'completed-unverified',
]);

/**
 * Alias preserved for symmetry with other contracts that suffix with
 * `Schema` (e.g. {@link acceptanceGateSchema}).
 *
 * Identical to {@link ArchiveReason}. Prefer `ArchiveReason` for direct
 * literal access; prefer `ArchiveReasonSchema` when passing the schema
 * object into a generic helper (e.g. `createInsertSchema`).
 */
export const ArchiveReasonSchema = ArchiveReason;

/**
 * Inferred TypeScript union type for {@link ArchiveReason}.
 *
 * Equivalent to:
 * ```ts
 * type ArchiveReasonValue =
 *   | 'verified'
 *   | 'reconciled'
 *   | 'superseded'
 *   | 'shadowed'
 *   | 'cancelled'
 *   | 'completed-unverified';
 * ```
 */
export type ArchiveReasonValue = z.infer<typeof ArchiveReason>;

/**
 * Readonly tuple of all valid archive-reason values, in canonical order.
 *
 * Useful when a Drizzle column or a discriminated union needs the raw
 * tuple form (e.g. `text('archive_reason', { enum: ARCHIVE_REASON_VALUES })`).
 */
export const ARCHIVE_REASON_VALUES = ArchiveReason.options;

/**
 * The single tombstone value within {@link ArchiveReason}.
 *
 * Writing this value from non-migration code paths MUST throw
 * {@link ArchiveReasonTombstoneError}. The value exists in the enum so the
 * DB CHECK constraint accepts rows backfilled by the migration ingest, but
 * application code (CLI, archive bulk path, single-task archive) must
 * derive a more specific reason (`verified`, `reconciled`, `cancelled`,
 * etc.) before writing.
 */
export const ARCHIVE_REASON_TOMBSTONE = 'completed-unverified' as const;

/**
 * Error thrown when application code attempts to write the tombstone
 * value `'completed-unverified'` outside the permitted migration-backfill
 * path.
 *
 * Acceptance criteria T1407: "Writing 'completed-unverified' from new
 * code throws E_ARCHIVE_REASON_TOMBSTONE; only migration backfill may
 * write it."
 *
 * @example
 * ```ts
 * if (reason === ARCHIVE_REASON_TOMBSTONE && !allowMigrationBackfill) {
 *   throw new ArchiveReasonTombstoneError(taskId);
 * }
 * ```
 */
export class ArchiveReasonTombstoneError extends Error {
  readonly code = 'E_ARCHIVE_REASON_TOMBSTONE';
  readonly taskId?: string;

  constructor(taskId?: string) {
    super(
      taskId
        ? `archiveReason='completed-unverified' is a tombstone — only migration backfill may write it (taskId=${taskId})`
        : "archiveReason='completed-unverified' is a tombstone — only migration backfill may write it",
    );
    this.name = 'ArchiveReasonTombstoneError';
    this.taskId = taskId;
  }
}

/**
 * Environment / context flag that callers MUST set to `true` (or to the
 * env var `CLEO_ARCHIVE_ALLOW_TOMBSTONE=1`) before writing the tombstone.
 *
 * Centralized here so every write path uses the same gate constant.
 */
export const ARCHIVE_REASON_TOMBSTONE_ENV = 'CLEO_ARCHIVE_ALLOW_TOMBSTONE';

/**
 * Returns true iff the current process is permitted to write the
 * tombstone value (migration backfill path or owner-override).
 *
 * @internal Used by core/store archive write paths to gate tombstone
 * writes; not part of the public contracts API surface.
 *
 * @remarks
 * The contracts package is a zero-runtime-dependency leaf, so it does
 * not pull in `@types/node`. Accessing `process.env` via
 * `globalThis` keeps the package portable (works in Node, browsers,
 * Deno, Bun, edge runtimes — `process` is undefined off-Node and the
 * function returns `false` there).
 */
export function isArchiveTombstoneAllowed(): boolean {
  // biome-ignore lint/suspicious/noExplicitAny: globalThis.process is intentionally untyped — see remarks above.
  const env = (globalThis as any)?.process?.env as Record<string, string | undefined> | undefined;
  return env?.[ARCHIVE_REASON_TOMBSTONE_ENV] === '1';
}

/**
 * Validates a candidate archive reason and enforces the tombstone gate.
 *
 * - Rejects values outside the 6-value enum with a Zod error.
 * - Rejects `'completed-unverified'` unless {@link isArchiveTombstoneAllowed}
 *   returns `true`.
 *
 * @param reason - candidate archive-reason string
 * @param taskId - optional task id, used in the error message
 * @returns the validated, narrowed {@link ArchiveReasonValue}
 * @throws {@link ArchiveReasonTombstoneError} when reason is the tombstone
 *   and the migration-backfill gate is not enabled
 */
export function assertArchiveReason(reason: string, taskId?: string): ArchiveReasonValue {
  const parsed = ArchiveReason.parse(reason);
  if (parsed === ARCHIVE_REASON_TOMBSTONE && !isArchiveTombstoneAllowed()) {
    throw new ArchiveReasonTombstoneError(taskId);
  }
  return parsed;
}
