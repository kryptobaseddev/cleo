/**
 * Shared types for the `cleo exodus` migration subsystem.
 *
 * The exodus subsystem migrates data from the legacy multi-DB fleet
 * (tasks.db · brain.db · conduit.db · nexus.db · signaldock.db · skills.db)
 * into the consolidated dual-scope `cleo.db` (project + global).
 *
 * @task T11248 (E5 · SG-DB-SUBSTRATE-V2)
 * @saga T11242
 * @adr ADR-068, ADR-069
 */

/** The two consolidated target scopes. */
export type ExodusScope = 'project' | 'global';

/**
 * Descriptor for one legacy source database.
 *
 * Each legacy DB maps to a scope (project or global) and a set of tables
 * that will be copied into the consolidated `cleo.db` for that scope.
 */
export interface LegacyDbDescriptor {
  /** Logical name for display / logging. */
  readonly name: string;
  /** Absolute path to the legacy `.db` file. */
  readonly path: string;
  /** Consolidated target scope that will receive this DB's tables. */
  readonly targetScope: ExodusScope;
}

/**
 * Per-table migration status tracked inside the staging journal
 * (`exodus-journal.json`).
 *
 * - `pending`  — not yet attempted.
 * - `done`     — copied with no row deficit.
 * - `skipped`  — intentionally not copied (no consolidated home, empty source, …).
 * - `partial`  — copied, but with a KNOWN-recovered / known-lossy row deficit on
 *   a non-data-bearing or already-reconciled table. Recorded so the table does
 *   NOT masquerade as `done`, yet a single belt-and-suspenders deficit does not
 *   trip a scope-wide rollback. A genuine deficit on a data-bearing BASE table
 *   still aborts via the parity gate ({@link isDataContinuityOk}). (T11782 · FIX C.)
 */
export type TableMigrationStatus = 'pending' | 'done' | 'skipped' | 'partial';

/** Journal entry for one source table. */
export interface JournalTableEntry {
  readonly sourceDb: string;
  readonly tableName: string;
  status: TableMigrationStatus;
  rowsCopied: number;
  /** ISO-8601 timestamp of last update. */
  updatedAt: string;
  /** Error message if status ended in a non-retryable skip. */
  error?: string;
}

/**
 * Contents of `.cleo/exodus-staging-<iso>/exodus-journal.json`.
 *
 * Written before the migration begins and updated atomically after each table
 * copy so that a crash can be resumed from the last completed table.
 */
export interface ExodusJournal {
  /** Exodus format version — bump when the schema changes. */
  readonly version: 1;
  /** cleo package version at the time the migration was started. */
  readonly cleoVersion: string;
  /** Drizzle v1.0.0-rc.3 schema hash (constant — used for cross-version guard). */
  readonly targetSchemaVersion: string;
  /** Node.js version at migration time. */
  readonly nodeVersion: string;
  /** SQLite version at migration time. */
  readonly sqliteVersion: string;
  /** ISO-8601 timestamp when the journal was first created. */
  readonly startedAt: string;
  /** ISO-8601 timestamp of last update. */
  updatedAt: string;
  /** Per-table progress entries. Ordered by (sourceDb, tableName). */
  tables: JournalTableEntry[];
}

/**
 * Result of a single `ExodusTable` copy operation.
 *
 * Returned by `copyTable` and collected into the migration report.
 */
export interface TableCopyResult {
  readonly sourceDb: string;
  readonly tableName: string;
  readonly rowsCopied: number;
  readonly skipped: boolean;
  readonly reason?: string;
}

/**
 * Top-level exodus plan — computed by `buildExodusPlan()` before any writes.
 *
 * Carries all pre-flight information including disk-space check results so
 * that `--dry-run` can print a rich preview.
 */
export interface ExodusPlan {
  /** The legacy source descriptors that will participate in the migration. */
  readonly sources: LegacyDbDescriptor[];
  /** Combined size of all source DB files in bytes. */
  readonly totalSourceBytes: number;
  /** Available disk bytes on the target filesystem. */
  readonly availableBytes: number;
  /** Whether the 3× free-disk pre-flight passes. */
  readonly diskPreflight: boolean;
  /** Absolute path to the staging directory. */
  readonly stagingDir: string;
  /** Whether a staging directory from a previous run was found (resume mode). */
  readonly resumeFromStaging: boolean;
  /** Absolute path to the target project cleo.db. */
  readonly projectDbPath: string;
  /** Absolute path to the target global cleo.db. */
  readonly globalDbPath: string;
}

/**
 * Result returned by `runExodusMigrate()`.
 */
export interface ExodusMigrateResult {
  readonly ok: boolean;
  readonly tables: TableCopyResult[];
  readonly stagingDir: string;
  readonly backupPaths: string[];
  /** Error message if `ok === false`. */
  readonly error?: string;
}

/**
 * Per-table verification entry produced by `runExodusVerify()`.
 */
export interface VerifyTableResult {
  readonly tableName: string;
  readonly scope: ExodusScope;
  /** Row count in the source legacy DB. */
  readonly sourceCount: number;
  /** Row count in the consolidated cleo.db. */
  readonly targetCount: number;
  /** xxhash3-based ordered canonical-JSON digest (hex). */
  readonly sourceHash: string;
  readonly targetHash: string;
  readonly hashMatch: boolean;
  readonly countMatch: boolean;
}

/**
 * Result returned by `runExodusVerify()`.
 */
export interface ExodusVerifyResult {
  readonly ok: boolean;
  readonly tables: VerifyTableResult[];
  readonly error?: string;
}

/**
 * Status returned by `runExodusStatus()`.
 */
export interface ExodusStatusResult {
  /** Whether a staging journal exists from a previous (possibly incomplete) run. */
  readonly hasStaging: boolean;
  readonly stagingDir: string | null;
  readonly journal: ExodusJournal | null;
  /** Whether the consolidated project-scope cleo.db already exists. */
  readonly projectDbExists: boolean;
  /** Whether the consolidated global-scope cleo.db already exists. */
  readonly globalDbExists: boolean;
  /** Whether all source legacy DBs exist. */
  readonly sourcesPresent: boolean;
  readonly sources: Array<{ name: string; path: string; exists: boolean; bytes: number }>;
}

/**
 * Canonical schema version tag embedded in the exodus journal.
 *
 * This constant represents the Drizzle v1.0.0-rc.3 target schema "epoch"
 * for the dual-scope consolidation (T11245 · E2 · SG-DB-SUBSTRATE-V2).
 * The exact value is a stable marker — not a live hash — so that import
 * refuses cross-version migration unless `--force-cross-version` is passed.
 */
export const EXODUS_TARGET_SCHEMA_VERSION = 'drizzle-v1.0.0-rc.3/dual-scope/2026-05' as const;
