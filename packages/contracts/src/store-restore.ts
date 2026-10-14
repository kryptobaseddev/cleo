/**
 * `cleo restore backup --snapshot <file> | --id <backupId>`: restore the live
 * project `cleo.db` (which holds the tasks AND brain tables) from a named
 * snapshot or a backup id, safely (T13240).
 *
 * @task T13240
 */

/** Where the snapshot came from. */
export interface StoreRestoreSource {
  /** `snapshot`: a file named on the command line; `backup`: a backup id from `cleo backup list`. */
  readonly kind: 'snapshot' | 'backup';
  /** The file restored from (resolved, absolute). */
  readonly path: string;
  /** The backup id (`backup` only). */
  readonly backupId: string | null;
}

/** What the snapshot verification found. */
export interface StoreRestoreVerification {
  /** `PRAGMA integrity_check` on a private copy of the snapshot: `ok`, or the first problems. */
  readonly integrity: string;
  /** Tasks in the snapshot (`tasks_tasks`). */
  readonly tasks: number;
  readonly sizeBytes: number;
}

/** The live store file that was replaced, kept so the restore can be undone. */
export interface StoreRestoreKept {
  /** Backup id the kept file is listed under (`cleo backup list`), restorable with `--id`. */
  readonly backupId: string;
  /** The kept store file. */
  readonly path: string;
  /** Whether the live WAL was folded into the kept file (otherwise its raw sidecars are kept beside it). */
  readonly checkpointed: boolean;
  /** Raw sidecar copies kept beside it (`-wal`, `-shm`, `-journal`), when not checkpointed. */
  readonly sidecars: readonly string[];
}

/**
 * The docs byte surfaces restored from a backup id (T13704, T13708): the
 * blob-store and attachment databases and the byte files `docs fetch` reads.
 */
export interface StoreRestoreDocsBytes {
  /** `true` only when every recorded database and byte file was verified and placed. */
  readonly complete: boolean;
  /** Databases placed, relative to `.cleo/` (`blobs/manifest.db`, `attachments/index.db`). */
  readonly dbsRestored: readonly string[];
  /** Byte files verified (sha256) and placed. */
  readonly filesRestored: number;
  /** What was not placed, each `<path>: <why>` (missing, sha256 mismatch, integrity_check, busy). */
  readonly failed: readonly string[];
}

/** Result of a store restore (or its dry run). */
export interface StoreRestoreResult {
  readonly dryRun: boolean;
  /** `project` (`.cleo/cleo.db`) or `global` (`<CLEO_HOME>/cleo.db`, T13245). */
  readonly scope: 'project' | 'global';
  readonly restored: boolean;
  /** The live store file. */
  readonly target: string;
  readonly source: StoreRestoreSource;
  readonly verification: StoreRestoreVerification;
  /** The replaced store, kept (`null` on a dry run, or when there was no live store). */
  readonly kept: StoreRestoreKept | null;
  /** Live-file sidecars removed so the restored file is not read with the old journal. */
  readonly removedSidecars: readonly string[];
  /** How to undo the restore (`null` on a dry run, or when nothing was replaced). */
  readonly undo: string | null;
  /**
   * The docs byte surfaces restored with the store (`--id` of a backup that
   * captured them, T13708). Absent otherwise.
   */
  readonly docsBytes?: StoreRestoreDocsBytes;
  /**
   * `true` when the store was placed but part of the backup was not (a docs
   * byte that was missing or failed verification): the restore is not a
   * clean success and the CLI exits non-zero (T13709).
   */
  readonly partial?: boolean;
  /** What the partial restore left out, one line each. */
  readonly warnings?: readonly string[];
}

/**
 * `cleo backup recover tasks|brain|conduit`: the freshest valid snapshot of the
 * project store, restored through the same safe path as `cleo restore backup`
 * (T13245). All three roles name the one live file, `.cleo/cleo.db`.
 */
export interface StoreRecoverResult extends StoreRestoreResult {
  /** The role asked for (`tasks`, `brain` or `conduit`); the store restored is `cleo.db` either way. */
  readonly role: string;
  /** Snapshots that failed `PRAGMA quick_check` before one passed (newest first). */
  readonly rejected: readonly string[];
  /** Hours between the chosen snapshot and now, or `null` when its time is unknown. */
  readonly dataLossWindowHours: number | null;
}
