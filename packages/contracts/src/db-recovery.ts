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

/** High-water marks from a key table in a disposable store image. */
export interface StoreTableHighWater {
  /** Physical table name. */
  table: string;
  /** Number of readable rows. */
  rows: number;
  /** Largest rowid, encoded without losing 64-bit precision. */
  maxRowid: string | null;
  /** Latest created, updated, session or audit timestamp in Unix seconds. */
  latestAt: number | null;
}

/** Evidence of newer snapshot history or WAL commits that SQLite cannot apply. */
export interface StoreFreshnessFinding {
  /** Snapshot or original WAL path. */
  source: string;
  /** Recovery source whose contents advanced beyond the visible store. */
  kind: 'snapshot' | 'wal';
  /** Compared high-water marks naming the affected tables. */
  evidence: string[];
  /** SQLite rejected apparent commits; the quarantine remains necessary for investigation. */
  unreadable?: boolean;
  /** False for a retained backup excluded by an explicit rollback. */
  authoritative?: boolean;
  /** Whether assessed history has live-only keys; omitted when not assessed. */
  divergent?: boolean;
}

/** Read-only integrity and freshness assessment performed on disposable copies. */
export interface StoreIntegrityInspection {
  /** True when integrity and freshness checks pass, or the store is absent. */
  healthy: boolean;
  /** Integrity findings, a read failure, or absent. */
  detail: string;
  /** Newer recoverable history, when physical integrity alone would pass. */
  freshness?: StoreFreshnessFinding[];
}

/** Restartable phases of a whole-store repair; the commit is one atomic rename. */
export type StoreRepairPhase =
  | 'quarantine'
  | 'diagnose'
  | 'salvage'
  | 'merge'
  | 'migrate'
  | 'validate'
  | 'commit'
  | 'checkpoint'
  | 'checkpointed'
  | 'receipt';

/** Row accounting for one table, including damage whose extent cannot be counted. */
export interface StoreRepairTable {
  /** Rows in the validated base, before the merge or migrations. */
  snapshot: number;
  /** Distinct readable keys extracted from the damaged store. */
  salvaged: number;
  /** Insertions and updates applied to the base. */
  merged: number;
  /** Unreadable rows, or null when a damaged page hides its row count. */
  unreadable: number | null;
  /** Rows in the validated result. */
  final: number;
  /** Snapshot rows removed by a proven deletion or quarantined foreign-key conflict. */
  baseRemoved?: number;
  /** Snapshot rows missing from a complete damaged view, reported as deletions. */
  deleted?: number;
  /** Snapshot rows retained because incomplete reads cannot prove a deletion. */
  possiblyResurrected?: number;
  /** Rows excluded from the healthy result and preserved in the recovery file. */
  conflicts?: number;
  /** Derived virtual-table storage rebuilt through its content table. */
  rebuilt?: boolean;
}

/** A SQLite value encoded without losing 64-bit integers or binary data in JSON. */
export type StoreRepairValue = string | number | null | { type: 'bigint' | 'blob'; value: string };

/** Data kept for investigation or manual recovery, including proven and possible deletions. */
export interface StoreRepairRecoveryRow {
  /** Why the row is recorded separately from the repaired content. */
  kind: 'unmerged-columns' | 'conflict' | 'deleted' | 'possibly-resurrected';
  /** Original table name. */
  table: string;
  /** Specific columns, constraint, or incomplete-read finding. */
  reason: string;
  /** Damaged view that supplied an alternate version, when known. */
  source?: string;
  /** Original values, including a rowid when the table has one. */
  values: Record<string, StoreRepairValue>;
}

/** A byte-for-byte original kept before attempting a repair. */
export interface StoreRepairFile {
  /** Original filename, including any SQLite sidecar suffix. */
  name: string;
  /** SHA-256 of the original and its quarantine copy. */
  sha256: string;
  /** Original size in bytes. */
  bytes: number;
}

/** Explicit rollback intent retained with the repair receipt and the store marker. */
export interface StoreRestoreIntent {
  /** Explicitly selected snapshot. */
  snapshot: string;
  /** SHA-256 of the selected snapshot's original main file. */
  snapshotSha256: string;
  /** Time the deliberate rollback began. */
  restoredAt: string;
  /** Pre-existing backup images excluded from subsequent automatic recovery. */
  ignoredSnapshots: StoreRepairFile[];
}

/** A rollback marker prepared before publication and finalized before releasing restore exclusion. */
export interface StoreRestoreIntentMarker {
  /** Marker format. */
  version: 1;
  /** Canonical store to which the intent applies. */
  target: string;
  /** Prepared markers need image proof; committed intent survives later writes. */
  state: 'prepared' | 'committed';
  /** New intent, or an explicit clear. */
  intent: StoreRestoreIntent | null;
  /** Earlier intent remains applicable while the old image is still present. */
  previous: StoreRestoreIntent | null;
  /** Main image installed by this restore. */
  mainSha256: string;
  /** Full-image WAL installed by repair, when applicable. */
  walSha256?: string;
  /** Original main image before publication. */
  previousMainSha256?: string;
  /** Original WAL before publication, when present. */
  previousWalSha256?: string;
}

/** Recovery file reference and its losslessly encoded records. */
export interface StoreRepairRecovery {
  /** Quarantine JSON path, or null for a dry run. */
  file: string | null;
  /** Excluded data and explicit deletion accounting. */
  rows: StoreRepairRecoveryRow[];
}

/** Durable receipt returned by doctor, backup recovery, and automatic recovery. */
export interface StoreRepairReceipt {
  /** Version of this receipt format. */
  version: 1;
  /** Physical store scope. */
  scope: 'project' | 'global';
  /** Canonical path of the store. */
  target: string;
  /** UTC time at the start of the attempt. */
  startedAt: string;
  /** Healthy and absent stores require no mutation. */
  status:
    | 'healthy'
    | 'absent'
    | 'prepared'
    | 'checkpoint-pending'
    | 'repaired'
    | 'dry-run'
    | 'failed';
  /** Immutable original copies; null for a no-op or dry run. */
  quarantineDir: string | null;
  /** Validated snapshot used as a base; null means a fresh schema. */
  snapshot: string | null;
  /** Timestamp of the chosen snapshot, when known. */
  snapshotAt: string | null;
  /** SHA-256 of the committed full-image WAL, used to resume an interrupted checkpoint. */
  commitWalSha256?: string;
  /** SHA-256 of its fully checkpointed main image. */
  commitMainSha256?: string;
  /** Whether readable live rows were merged. */
  delta: boolean;
  /** Rollback intent; null explicitly clears an earlier deliberate rollback. */
  restoreIntent?: StoreRestoreIntent | null;
  /** Preserved original file hashes. */
  files: StoreRepairFile[];
  /** Per-table accounting. */
  tables: Record<string, StoreRepairTable>;
  /** Commit-message task IDs since the snapshot missing from the repaired store. */
  missingTaskIds: string[];
  /** Extraction failures and unavailable optional tools. */
  diagnostics: string[];
  /** Freshness evidence that triggered a lossless union instead of deletion inference. */
  freshness?: StoreFreshnessFinding[];
  /** Excluded data and deletion accounting; also persisted beside the immutable originals. */
  recovery?: StoreRepairRecovery;
  /** True only after integrity, foreign-key, and base-count verification. */
  integrityOK: boolean;
}

/** Inputs for the lossless, copy-only whole-store recovery pipeline. */
export interface StoreRepairOptions {
  /** Project root for path resolution and the report-only git log scan. */
  projectRoot: string;
  /** Invocation directory, used by the worktree rewrite guard. */
  cwd: string;
  /** Defaults to project scope. */
  scope?: 'project' | 'global';
  /** Perform the entire repair on private temporary copies, without a commit. */
  dryRun?: boolean;
  /** Optional backup path or timestamp prefix. */
  fromSnapshot?: string;
  /** Explicitly retain snapshot-only recovery, discarding readable delta rows. */
  noDelta?: boolean;
  /** Confirm a worktree invocation against its owning project's store. */
  confirmOwnerStore?: boolean;
  /** Canonical failed opens follow the existing audited open-time owner-store policy. @internal */
  openTime?: boolean;
  /** Backup recovery may explicitly restore a healthy store. Doctor never does. */
  restoreSnapshot?: boolean;
  /** Phase boundary for interruption tests. @internal */
  onPhase?: (phase: StoreRepairPhase) => void;
}

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

/**
 * Per-role outcome of a `cleo doctor repair` pass (T11829 · DHQ-060).
 *
 * `doctor repair` first PROBES each role's live DB via `PRAGMA quick_check`
 * (the same probe the recovery pipeline runs on snapshot candidates) and only
 * invokes the {@link recoverMalformedDb} → quarantine → restore-from-snapshot →
 * verify pipeline for roles that are actually malformed. This record captures
 * what was observed and done for one role.
 *
 * @task T11829
 * @epic T11833
 * @saga T11242
 * @public
 */
export interface DoctorRepairRoleResult {
  /** Canonical role inspected. */
  role: DbRole;
  /** Absolute path to the role's live DB file (resolved from `DB_INVENTORY`). */
  dbPath: string;
  /** `true` when the live DB file exists on disk. */
  present: boolean;
  /**
   * `true` when the live DB passed `PRAGMA quick_check` (or was absent) — i.e.
   * NO repair was needed. `false` when corruption was detected.
   */
  healthy: boolean;
  /**
   * `'skipped'` — healthy or absent, nothing done;
   * `'would-repair'` — `--dry-run`, corruption detected, repair NOT performed;
   * `'repaired'` — corruption detected and snapshot restore succeeded;
   * `'failed'` — corruption detected but recovery could not complete.
   */
  action: 'skipped' | 'would-repair' | 'repaired' | 'failed';
  /** Absolute path to the snapshot restored (or that would be), when applicable. */
  restoredFrom: string | null;
  /** Absolute path to the quarantined corrupt DB, when a repair was performed. */
  quarantinedTo: string | null;
  /** Approximate data-loss window in hours, when a snapshot timestamp was parsed. */
  dataLossWindowHours: number | null;
  /** Human-readable detail (probe outcome, error reason, or restore summary). */
  detail: string;
}

/**
 * Aggregate result of a `cleo doctor repair` invocation across one or more roles
 * (T11829 · DHQ-060).
 *
 * @task T11829
 * @epic T11833
 * @saga T11242
 * @public
 */
export interface DoctorRepairResult {
  /** `true` when the run was a `--dry-run` (no files mutated). */
  dryRun: boolean;
  /** Per-role outcomes. */
  roles: DoctorRepairRoleResult[];
  /** Count of roles found malformed (`!healthy`). */
  malformedCount: number;
  /** Count of roles actually repaired this run. */
  repairedCount: number;
  /** Count of roles where a needed repair FAILED. */
  failedCount: number;
}

/** Cheap immutable-image identity; full hashes are needed only for candidate collisions or restore intent. */
export interface StoreSnapshotIdentity {
  /** Path, inode and change times invalidate cached validation after a physical rewrite. */
  cacheKey: string;
  /** Size and SQLite/WAL headers group possible duplicate images despite differing mtimes. */
  duplicateKey: string;
}

/** A store checkpoint and the retained ancestor checkpoints its history proves. */
export interface StoreGeneration {
  /** Random identity of a completed snapshot checkpoint. */
  readonly current: string;
  /** Bounded ancestor identities, including the current checkpoint. */
  readonly history: readonly string[];
}
