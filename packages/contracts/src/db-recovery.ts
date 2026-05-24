/**
 * Generic CLEO database recovery contracts — generalised from the brain-only
 * T10303/T10304 shapes so the same envelope works for every role declared in
 * {@link DB_INVENTORY}.
 *
 * These types mirror {@link BrainRecoveryResult} + {@link BackupRecoverBrainResult}
 * almost verbatim, with two adjustments:
 *
 * 1. `observationsRecovered: number | null` is generalised to
 *    `rowCounts: DbRecoveredRowCounts` — a `Record<tableName, number | null>`
 *    keyed by the user tables discovered in the restored DB via
 *    `sqlite_master`. Tables that fail to count surface as `null`.
 * 2. Every envelope carries the `role: DbRole` it pertains to so envelopes from
 *    `cleo backup recover <role>` are self-describing across tools that may
 *    fan recovery out across multiple DBs.
 *
 * The brain-specific shapes ({@link BrainRecoveryResult},
 * {@link BackupRecoverBrainResult}, {@link BrainRecoveredRowCounts}) remain in
 * {@link brain.ts} as the backward-compatible surface — the brain CLI verb
 * (`cleo backup recover brain`) still emits the same envelope it did before
 * T10318 generalised the pipeline.
 *
 * @task T10318
 * @epic T10284
 * @saga T10281
 * @adr ADR-068
 */

import type { DbRole } from './db-inventory.js';

/**
 * Best-effort per-table row counts probed from a recovered CLEO database.
 *
 * @remarks
 * The recovery pipeline enumerates user tables in the restored DB via
 * `sqlite_master` (excluding internal `sqlite_*` and Drizzle journal tables)
 * and runs `SELECT COUNT(*)` on each. Tables that fail to count — for
 * example, a missing table in a very old snapshot, or a schema/version
 * mismatch — surface as `null` instead of throwing so the envelope always
 * serialises cleanly.
 *
 * Keys are exact SQLite table names (case-sensitive). Values are non-negative
 * integers or `null`.
 *
 * @public
 */
export type DbRecoveredRowCounts = Readonly<Record<string, number | null>>;

/**
 * Result of a generic CLEO DB auto-recovery attempt.
 *
 * @remarks
 * Returned by `recoverMalformedDb({ role, ... })` (T10318) when the chokepoint
 * (or an operator invoking `cleo backup recover <role>`) detects malformation
 * via `ERR_SQLITE_ERROR errcode=11` or a failing `PRAGMA integrity_check` /
 * `PRAGMA quick_check`. The corrupt DB has been moved to a quarantine
 * directory and the freshest validated snapshot has been copied to the
 * canonical role path.
 *
 * Consumers read this structure to decide whether to re-attempt the open and
 * to emit user-facing diagnostics with the data-loss window.
 *
 * @public
 */
export interface DbRecoveryResult {
  /** Canonical role of the database that was recovered. */
  role: DbRole;
  /** Absolute path to the snapshot that was restored, or `null` if recovery failed. */
  restoredFrom: string | null;
  /**
   * Approximate hours between the snapshot's timestamp and the recovery
   * event. `null` when the snapshot timestamp could not be parsed.
   * Used in the recovery warning to make the data-loss window legible.
   */
  dataLossWindowHours: number | null;
  /**
   * Per-table row counts probed from the restored DB. Each key is a user
   * table name; each value is the row count, or `null` on count failure.
   * Empty record `{}` when the restored DB has no user tables (or when
   * the probe itself failed to open the DB).
   */
  rowCounts: DbRecoveredRowCounts;
  /** `true` if the restored DB passes `PRAGMA quick_check`. */
  integrityOK: boolean;
  /**
   * Absolute path to the quarantine directory where the corrupt DB plus
   * its `-wal`/`-shm` sidecars were moved before restore. `null` when no
   * corrupt DB existed at the canonical path (recovery into an empty slot).
   */
  quarantineDir: string | null;
}

/**
 * Envelope payload returned by `cleo backup recover <role>`.
 *
 * @remarks
 * Wraps {@link DbRecoveryResult} with three CLI-only additions:
 *
 * - `rowsRecovered` aliases `rowCounts` to keep the envelope shape compatible
 *   with the brain-specific {@link BackupRecoverBrainResult}.
 * - `quarantinedTo: string` is the non-nullable string form (empty string in
 *   `--dry-run` mode where no files were touched) — easier for shell scripts
 *   that pipe the envelope into `jq` and then path operations.
 * - `dryRun: boolean` records whether the envelope is a *plan* (would-do)
 *   versus a *record* (already-done). Consumers MUST check this before
 *   treating `restoredFrom` as a post-condition.
 *
 * @task T10318
 * @epic T10284
 * @saga T10281
 * @public
 */
export interface BackupRecoverResult {
  /** Canonical role of the database that was (or would be) recovered. */
  role: DbRole;
  /**
   * Absolute path to the snapshot that was (or would be) restored. Empty
   * string when no snapshot was available — the envelope's caller surfaces
   * that as a failure mode via a structured error.
   */
  restoredFrom: string;
  /** Per-table row counts probed from the restored DB (or the plan target). */
  rowsRecovered: DbRecoveredRowCounts;
  /**
   * Approximate hours between the snapshot's timestamp and the recovery
   * event. `null` when the snapshot timestamp could not be parsed (e.g.
   * legacy `<role>.db.PRE-DUP-FIX-*` fallback artifact).
   */
  dataLossWindowHours: number | null;
  /** `true` when the restored DB passes `PRAGMA quick_check`. */
  integrityOK: boolean;
  /**
   * Absolute path to the quarantine directory where the corrupt DB plus
   * its `-wal`/`-shm` sidecars were moved. Empty string in `--dry-run`
   * mode where no files were touched.
   */
  quarantinedTo: string;
  /**
   * `true` when invoked with `--dry-run` — indicates the envelope is a
   * plan, NOT a record of mutations performed. Consumers MUST check this
   * before treating `restoredFrom` as a post-condition.
   */
  dryRun: boolean;
}
