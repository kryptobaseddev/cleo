/**
 * Backup and restore core module.
 *
 * Produces full-`.cleo/` snapshots containing tasks.db, brain.db, config.json
 * and project-info.json using the safest available method for each file type:
 *
 *   - SQLite databases: `VACUUM INTO` via the live native handle (see
 *     {@link ../store/sqlite-backup.ts}). This is the ONLY safe way to
 *     snapshot a WAL-mode SQLite database while it is open — raw filesystem
 *     copies can capture torn writes or stale WAL frames.
 *
 *   - JSON files: atomic tmp-then-rename via {@link atomicWriteSync} so a
 *     partial write can never corrupt the backup target.
 *
 * Snapshots are recorded under `.cleo/backups/sqlite/` with a JSON sidecar
 * (`{backupId}.meta.json`) enumerating which files were captured and how.
 * Restores read the same sidecars and materialize each file back into the
 * live `.cleo/` directory.
 *
 * This is the backing store for the `cleo backup` and `cleo restore backup`
 * CLI verbs (see packages/cleo/src/cli/commands/backup.ts and restore.ts).
 *
 * ## Canonical backup path (T10315 · ADR-013 §10 · Saga T10281 / Epic T10284)
 *
 * Both this module and {@link ../store/sqlite-backup.ts} (the auto session-end
 * snapshotter) write to the SAME directory: `.cleo/backups/sqlite/`. The two
 * producers use distinguishable filename schemes that coexist:
 *
 *   - `vacuumIntoBackupAll` writes `tasks-YYYYMMDD-HHmmss.db` /
 *     `brain-YYYYMMDD-HHmmss.db` (no sidecar).
 *   - `createBackup` writes `<file>.<backupId>` + `<backupId>.meta.json`,
 *     where `backupId = <type>-YYYYMMDD-HHmmss` (matching the same local-time
 *     timestamp format).
 *
 * The legacy `.cleo/backups/snapshot/` directory is retained as a read-only
 * fallthrough for one deprecation window — `listSystemBackups` enumerates
 * both directories and tags legacy entries via `legacy: true`, and
 * `restoreBackup` searches the legacy directory if no candidate is found in
 * the canonical directory. A one-time `DeprecationWarning` fires when the
 * legacy directory is consulted.
 *
 * @task T4783
 * @task T5158 — extended to use VACUUM INTO for .db files and atomicWrite for JSON
 * @task T10315 — ratified `.cleo/backups/sqlite/` as the single canonical path
 *                (ADR-013 §10). The previous `.cleo/backups/snapshot/` is now
 *                a deprecated read-only fallthrough for one release.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { StoreRestoreResult } from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { CleoError } from '../errors.js';
import { formatBackupTimestamp, rotateBackupDir } from '../store/backup-sidecar.js';
import { resolveDualScopeDbPath } from '../store/dual-scope-db.js';
import { getNativeDb } from '../store/sqlite.js';
import { assertRestoreTargetConfirmed } from '../store/worktree-isolation-guard.js';

/** Default max backup snapshots per backup type directory. */
const DEFAULT_MAX_SNAPSHOTS = 10;

/**
 * Canonical backup directory name (relative to `.cleo/`). All new backups
 * write here; reads fall through to the legacy directory below for one
 * deprecation window.
 *
 * @task T10315
 */
const CANONICAL_BACKUP_SUBDIR = 'sqlite';

/**
 * Legacy backup directory name (relative to `.cleo/`). Retained read-only
 * for one release after T10315 (ADR-013 §10 deprecation window).
 *
 * @task T10315
 */
const LEGACY_BACKUP_SUBDIR = 'snapshot';

/**
 * Module-level flag: have we already emitted the legacy-directory
 * DeprecationWarning during this process? Used to ensure the warning fires
 * exactly once per process even when both `listSystemBackups` and
 * `restoreBackup` consult the legacy directory.
 *
 * @task T10315
 */
let _legacyWarningEmitted = false;

/**
 * Emit the legacy-directory deprecation warning exactly once per process.
 *
 * @task T10315
 */
function emitLegacyDeprecationWarning(): void {
  if (_legacyWarningEmitted) return;
  _legacyWarningEmitted = true;
  // Node's emitWarning de-duplicates by (message, code) pair within a single
  // process, so even if a downstream consumer calls this we won't double-warn.
  process.emitWarning(
    'Reading SQLite backups from `.cleo/backups/snapshot/` — this path is ' +
      'deprecated and will be removed in the release after T10315. New ' +
      'backups now write to `.cleo/backups/sqlite/`. See ADR-013 §10.',
    {
      type: 'DeprecationWarning',
      code: 'CLEO_BACKUP_LEGACY_SNAPSHOT_DIR',
    },
  );
}

/** Internal: reset the once-flag (test seam). */
export function _resetLegacyWarningOnce(): void {
  _legacyWarningEmitted = false;
}

/** Safe wrapper around VACUUM INTO: flushes WAL then clones the DB. */
function safeSqliteSnapshot(db: { exec: (sql: string) => void } | null, destPath: string): boolean {
  if (!db) return false;
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const safeDest = destPath.replace(/'/g, "''");
  try {
    db.exec(`VACUUM INTO '${safeDest}'`);
  } catch (err) {
    // A failed VACUUM INTO can leave a partial (often empty) file that would
    // read as a backup (T13245).
    rmSync(destPath, { force: true });
    throw err;
  }
  return true;
}

/**
 * Synchronous atomic write: writes to a sibling `.tmp` file and renames on
 * success. Mirrors the behavior of `write-file-atomic` but in a sync flavor
 * suitable for `createBackup()` which has a sync contract throughout its
 * call chain.
 *
 * On rename failure the tmp file is best-effort cleaned up. Throws on the
 * originating error so callers can decide how to handle the backup partial.
 */
function atomicWriteSync(destPath: string, data: Buffer | string): void {
  mkdirSync(dirname(destPath), { recursive: true });
  const tmp = `${destPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, destPath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
}

/** Result shape returned by {@link createBackup}. */
export interface BackupResult {
  /** Unique backup identifier (timestamped). */
  backupId: string;
  /** Absolute path to the directory containing the snapshot files. */
  path: string;
  /** ISO-8601 timestamp when the backup was created. */
  timestamp: string;
  /** Backup category (`snapshot`, `safety`, `migration`). */
  type: string;
  /** Files that were successfully captured into this backup. */
  files: string[];
}

/** Result shape returned by {@link restoreBackup}. */
export interface RestoreResult {
  /** Whether any files were actually restored (false if none matched). */
  restored: boolean;
  /** The backup identifier that was restored. */
  backupId: string;
  /** ISO-8601 timestamp of the original backup. */
  timestamp: string;
  /** File names that were successfully restored back into `.cleo/`. */
  filesRestored: string[];
}

/**
 * Create a backup of the canonical CLEO data files.
 *
 * Produces safe copies via VACUUM INTO (for SQLite) and atomicWrite
 * (for JSON) into `.cleo/backups/sqlite/`. Writes a `{backupId}.meta.json`
 * sidecar describing the snapshot.
 *
 * The backup file naming uses the unified `YYYYMMDD-HHmmss` local-time format
 * (matching `sqlite-backup.ts:formatTimestamp`) so all snapshot files in
 * `.cleo/backups/sqlite/` share one timestamp convention. The `type` field
 * (`snapshot` by default) is embedded in the `backupId` to distinguish manual
 * snapshots from auto-snapshots and from `safety`/`migration` backups.
 *
 * Opens both `tasks.db` and `brain.db` through their canonical drizzle
 * accessors before snapshotting so that the native DB handles are live
 * when `safeSqliteSnapshot` asks for them. This makes the function
 * self-contained — callers do not need to pre-open the DBs.
 *
 * Async because opening the database engines requires async migration
 * reconciliation (ADR-012). The CLI dispatch layer awaits this result.
 *
 * @task T10315 — write target moved from `.cleo/backups/snapshot/` to
 *                `.cleo/backups/sqlite/` per ADR-013 §10.
 */
export async function createBackup(
  projectRoot: string,
  opts?: {
    type?: string;
    note?: string;
    /**
     * Maximum number of backup files to keep per type directory.
     * Oldest files are rotated out when this cap is exceeded.
     * Defaults to {@link DEFAULT_MAX_SNAPSHOTS} (10).
     *
     * @task T9194
     */
    maxSnapshots?: number;
  },
): Promise<BackupResult> {
  const cleoDir = join(projectRoot, '.cleo');
  const btype = opts?.type || 'snapshot';
  const now = new Date();
  const timestamp = now.toISOString();
  // Unified `YYYYMMDD-HHmmss` local-time stamp — matches
  // `sqlite-backup.ts:formatTimestamp`. The `type` discriminates manual
  // snapshots from auto-VACUUM-INTO files in the SAME directory.
  const backupId = `${btype}-${formatBackupTimestamp(now)}`;
  const backupDir = join(cleoDir, 'backups', CANONICAL_BACKUP_SUBDIR);

  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true });
  }

  // Open the project store so getNativeDb returns its live handle. Best
  // effort: if it fails, the JSON files are still backed up. A dynamic import
  // keeps drizzle out of test suites that mock the store layer.
  try {
    const { getDb } = await import('../store/sqlite.js');
    await getDb(projectRoot);
  } catch {
    // the store open failed: the sqlite target below is skipped
  }

  /**
   * Per-file backup strategy. SQLite files go through `safeSqliteSnapshot`
   * (VACUUM INTO), JSON files through `atomicWrite`. Anything not in this
   * table is skipped.
   */
  const sqliteTargets: Array<{
    file: string;
    getDb: () => { exec: (sql: string) => void } | null;
  }> = [
    // T13245: ONE copy of the project store. `.cleo/cleo.db` holds the tasks,
    // brain and conduit tables; the old `tasks.db`/`brain.db` labels were two
    // identical copies of it (still read by every reader).
    { file: PROJECT_STORE_BACKUP_FILE, getDb: () => getNativeDb(projectRoot) },
  ];
  const jsonTargets: string[] = ['config.json', 'project-info.json'];
  const backedUp: string[] = [];

  // SQLite via VACUUM INTO.
  for (const target of sqliteTargets) {
    // These are compatibility labels, not source paths. Post-E6 both canonical
    // accessors point at cleo.db; absence of legacy files says nothing about
    // source availability. The project-bound native handle is authoritative.
    const dest = join(backupDir, `${target.file}.${backupId}`);
    try {
      const ok = safeSqliteSnapshot(target.getDb(), dest);
      if (ok) {
        backedUp.push(target.file);
      }
    } catch {
      // skip files that fail to snapshot — backup remains partial but usable
    }
  }

  // JSON via atomic write.
  for (const file of jsonTargets) {
    const src = join(cleoDir, file);
    if (!existsSync(src)) continue;
    const dest = join(backupDir, `${file}.${backupId}`);
    try {
      const content = readFileSync(src);
      atomicWriteSync(dest, content);
      backedUp.push(file);
    } catch {
      // skip files that fail to copy
    }
  }

  // Write metadata sidecar.
  const metaPath = join(backupDir, `${backupId}.meta.json`);
  try {
    atomicWriteSync(
      metaPath,
      JSON.stringify(
        {
          backupId,
          type: btype,
          timestamp,
          note: opts?.note,
          files: backedUp,
          scope: 'project',
          ...(backedUp.includes('cleo.db') ? { contains: [...PROJECT_STORE_CONTENTS] } : {}),
        },
        null,
        2,
      ),
    );
  } catch {
    // non-fatal
  }

  // T9194: Rotate oldest backups when the cap is exceeded. Scoped to the
  // current `backupType` so vacuum-snapshot files in the same dir are never
  // touched.
  const maxSnapshots = opts?.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS;
  rotateBackupDir(backupDir, maxSnapshots, btype);

  return { backupId, path: backupDir, timestamp, type: btype, files: backedUp };
}

/** A single backup entry returned by listSystemBackups. */
export interface BackupEntry {
  /** Unique backup identifier (timestamped). */
  backupId: string;
  /** Backup category (`snapshot`, `safety`, `migration`). */
  type: string;
  /** ISO-8601 timestamp when the backup was created. */
  timestamp: string;
  /** Optional human-readable note attached at creation time. */
  note?: string;
  /** File names captured in this backup. */
  files: string[];
  /**
   * `true` when this entry was discovered under the deprecated legacy
   * `.cleo/backups/snapshot/` directory. Surfaces in the `cleo backup list`
   * envelope so the operator knows the entry is read-only and will become
   * unreachable in the release following T10315.
   *
   * @task T10315
   */
  legacy?: boolean;
  /**
   * `true` when the backup is pinned: rotation never deletes it (T12535, the
   * snapshot a twin collapse took before changing the store).
   */
  pinned?: boolean;
  /** Why it is pinned. */
  pinnedReason?: string;
  /** Which store the backup is of: `project` (`.cleo/cleo.db`) or `global` (`<CLEO_HOME>/cleo.db`). */
  scope?: 'project' | 'global';
  /**
   * What its store file holds (T13245): `tasks`, `brain` and `conduit` for a
   * project backup (one `cleo.db` copy, or the old `tasks.db`/`brain.db`
   * labels, which are identical copies of it), `global` for the global store.
   */
  contains?: string[];
}

/**
 * Labels a backup's copy of the project store carries. Since the store
 * consolidation they are all `.cleo/cleo.db` (tasks AND brain tables), so
 * restoring one by its label wrote a file nothing reads (T13245).
 */
const STORE_FILE_LABELS: ReadonlySet<string> = new Set(['cleo.db', 'tasks.db', 'brain.db']);

/**
 * The file name {@link createBackup} gives its copy of the project store
 * (`cleo.db.<backupId>`; before T13245 two identical copies labelled
 * `tasks.db` and `brain.db`).
 */
export const PROJECT_STORE_BACKUP_FILE = 'cleo.db';

/** What a project store backup holds: the consolidated `cleo.db` (T13245). */
const PROJECT_STORE_CONTENTS = ['tasks', 'brain', 'conduit'] as const;

/**
 * Read all `.meta.json` sidecars from a single directory, tagging each
 * entry with the supplied `legacy` flag. Skips malformed/unreadable
 * sidecars silently. Used by {@link listSystemBackups} to enumerate
 * canonical + legacy backup dirs without duplicating the scan logic.
 *
 * @task T10315 — extracted from `listSystemBackups` to share between the
 *                canonical `sqlite/` and the legacy `snapshot/` dirs.
 */
function readMetaSidecarsFromDir(
  backupDir: string,
  fallbackType: string,
  legacy: boolean,
): BackupEntry[] {
  if (!existsSync(backupDir)) return [];
  const out: BackupEntry[] = [];
  try {
    const files = readdirSync(backupDir).filter((f) => f.endsWith('.meta.json'));
    for (const metaFile of files) {
      try {
        const raw = readFileSync(join(backupDir, metaFile), 'utf-8');
        const meta = JSON.parse(raw) as Partial<BackupEntry>;
        if (meta.backupId && meta.timestamp) {
          const entry: BackupEntry = {
            backupId: meta.backupId,
            type: meta.type ?? fallbackType,
            timestamp: meta.timestamp,
            files: meta.files ?? [],
          };
          if (meta.note !== undefined) entry.note = meta.note;
          if (legacy) entry.legacy = true;
          if (meta.scope === 'project' || meta.scope === 'global') entry.scope = meta.scope;
          // An older sidecar names the store by its labels; they are all cleo.db.
          const contains =
            meta.contains ??
            (entry.files.some((f) => STORE_FILE_LABELS.has(f)) ? [...PROJECT_STORE_CONTENTS] : []);
          if (contains.length > 0) entry.contains = contains;
          if (meta.pinned === true) {
            entry.pinned = true;
            if (meta.pinnedReason !== undefined) entry.pinnedReason = meta.pinnedReason;
          }
          out.push(entry);
        }
      } catch {
        // skip malformed meta files
      }
    }
  } catch {
    // skip unreadable backup directories
  }
  return out;
}

/**
 * List all available system backups (`snapshot`, `safety`, `migration`).
 *
 * Reads `.meta.json` sidecar files written by {@link createBackup}. Walks
 * both the canonical `.cleo/backups/sqlite/` directory AND the deprecated
 * `.cleo/backups/snapshot/` directory (ADR-013 §10 read-side deprecation
 * window). Entries discovered under the legacy directory are tagged with
 * `legacy: true` so callers can surface a warning.
 *
 * This is a pure read operation — it does not modify any files. A one-time
 * `DeprecationWarning` is emitted via `process.emitWarning` when the legacy
 * directory yields ≥1 entry.
 *
 * @task T4783
 * @task T10315 — added canonical-dir scan + legacy-dir read fallthrough.
 */
export function listSystemBackups(projectRoot: string): BackupEntry[] {
  const cleoDir = join(projectRoot, '.cleo');
  const legacyTypes = ['snapshot', 'safety', 'migration'] as const;
  const entries: BackupEntry[] = [];

  // 1. Canonical directory: `.cleo/backups/sqlite/` — contains entries of
  //    every type (`snapshot`/`safety`/`migration`). Sidecars carry their
  //    own `type` field so we don't need to discriminate by sub-directory.
  const canonicalDir = join(cleoDir, 'backups', CANONICAL_BACKUP_SUBDIR);
  entries.push(...readMetaSidecarsFromDir(canonicalDir, 'snapshot', /* legacy */ false));

  // 2. Legacy directory: `.cleo/backups/snapshot/` — read-only fallthrough
  //    for one deprecation window (ADR-013 §10). Tag each entry as legacy.
  //
  //    Historically the legacy directory was organized as `snapshot/`,
  //    `safety/`, `migration/` siblings under `.cleo/backups/`. We enumerate
  //    all three so existing installs surface every pre-T10315 entry.
  let legacyFound = false;
  for (const btype of legacyTypes) {
    const legacyDir = join(cleoDir, 'backups', btype);
    const found = readMetaSidecarsFromDir(legacyDir, btype, /* legacy */ true);
    if (found.length > 0) legacyFound = true;
    entries.push(...found);
  }
  if (legacyFound) emitLegacyDeprecationWarning();

  // Sort newest first.
  return entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/** The global store's backup directory: `<CLEO_HOME>/backups/sqlite`. */
function globalBackupDir(): string {
  return join(dirname(resolveDualScopeDbPath('global')), 'backups', CANONICAL_BACKUP_SUBDIR);
}

/**
 * List the backups of the global store (`<CLEO_HOME>/cleo.db`, T13245), newest
 * first. Read-only.
 *
 * @returns The global backups, each tagged `scope: 'global'`.
 * @task T13245
 */
export function listGlobalBackups(): BackupEntry[] {
  return readMetaSidecarsFromDir(globalBackupDir(), 'snapshot', false)
    .map((e) => ({ ...e, scope: 'global' as const, contains: e.contains ?? ['global'] }))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/** Minimum age of the newest automatic global backup before another is taken. */
export const AUTO_GLOBAL_BACKUP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * The session-end backup of the global store (T13245): an `auto` backup via
 * {@link createGlobalBackup}, at most once per
 * {@link AUTO_GLOBAL_BACKUP_INTERVAL_MS} (the global store is shared by every
 * project, so every session end would otherwise copy it). Never throws.
 *
 * @param now - Clock (tests).
 * @returns The backup id written, or `null` when skipped or failed.
 * @task T13245
 */
export async function autoGlobalBackup(now: Date = new Date()): Promise<string | null> {
  try {
    const newest = listGlobalBackups().find((b) => b.type === 'auto');
    if (newest && now.getTime() - Date.parse(newest.timestamp) < AUTO_GLOBAL_BACKUP_INTERVAL_MS) {
      return null;
    }
    const r = await createGlobalBackup({ type: 'auto' });
    return r.files.length > 0 ? r.backupId : null;
  } catch {
    return null;
  }
}

/**
 * Back up the global store (`<CLEO_HOME>/cleo.db`: the global brain, nexus,
 * agent registry; T13245) as one `VACUUM INTO` copy under
 * `<CLEO_HOME>/backups/sqlite/cleo.db.<backupId>`, with a sidecar, rotated
 * like project backups. `cleo restore backup --scope global --id <backupId>`
 * restores it.
 *
 * @param opts - Backup type, note and rotation cap.
 * @returns What was written (`files` is empty when the store could not be opened).
 * @task T13245
 */
export async function createGlobalBackup(opts?: {
  type?: string;
  note?: string;
  maxSnapshots?: number;
}): Promise<BackupResult> {
  const btype = opts?.type || 'snapshot';
  const now = new Date();
  const timestamp = now.toISOString();
  const backupId = `${btype}-${formatBackupTimestamp(now)}`;
  const backupDir = globalBackupDir();
  mkdirSync(backupDir, { recursive: true });
  const backedUp: string[] = [];
  try {
    const { openDualScopeDb, getDualScopeNativeDb } = await import('../store/dual-scope-db.js');
    const db = getDualScopeNativeDb(await openDualScopeDb('global'));
    if (safeSqliteSnapshot(db, join(backupDir, `cleo.db.${backupId}`))) backedUp.push('cleo.db');
  } catch {
    // the global store could not be opened: nothing to back up
  }
  if (backedUp.length > 0) {
    atomicWriteSync(
      join(backupDir, `${backupId}.meta.json`),
      JSON.stringify(
        {
          backupId,
          type: btype,
          timestamp,
          note: opts?.note,
          files: backedUp,
          scope: 'global',
          contains: ['global'],
        },
        null,
        2,
      ),
    );
    rotateBackupDir(backupDir, opts?.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS, btype);
  }
  return { backupId, path: backupDir, timestamp, type: btype, files: backedUp };
}

/**
 * Restore a backup into the live `.cleo/` directory.
 *
 * This operation overwrites the in-place copies of the files recorded in
 * the backup's sidecar. SQLite files are restored via a plain `copyFileSync`
 * because restore runs BEFORE the next CLEO process opens the database — no
 * WAL is active at that point — so a filesystem copy is safe. Callers must
 * ensure no CLEO process is concurrently writing to the target database.
 *
 * JSON files are restored via `atomicWrite` (tmp-then-rename) so a crash
 * mid-restore cannot produce a truncated config.
 *
 * Search order (T10315 / ADR-013 §10): canonical `.cleo/backups/sqlite/`
 * first, then legacy `.cleo/backups/{snapshot,safety,migration}/` as a
 * read-only fallthrough (emits a one-time DeprecationWarning if used).
 *
 * @task T10315
 */
export function restoreBackup(
  projectRoot: string,
  params: {
    backupId: string;
    force?: boolean;
    confirmOwnerStore?: boolean;
    cwd: string;
    /** Leave the store-file labels to {@link restoreBackupById} (T13245). */
    skipStoreFiles?: boolean;
  },
): RestoreResult {
  if (!params.backupId) {
    throw new CleoError(ExitCode.INVALID_INPUT, 'backupId is required');
  }
  // T12680: from a worktree this overwrites the owning project's live store.
  assertRestoreTargetConfirmed(projectRoot, params);

  const cleoDir = join(projectRoot, '.cleo');

  // Search order: canonical first, then legacy siblings.
  const searchOrder: Array<{ dir: string; legacy: boolean }> = [
    { dir: join(cleoDir, 'backups', CANONICAL_BACKUP_SUBDIR), legacy: false },
    { dir: join(cleoDir, 'backups', LEGACY_BACKUP_SUBDIR), legacy: true },
    { dir: join(cleoDir, 'backups', 'safety'), legacy: true },
    { dir: join(cleoDir, 'backups', 'migration'), legacy: true },
  ];

  let metaPath: string | null = null;
  let backupDir: string | null = null;
  let foundInLegacy = false;

  for (const { dir, legacy } of searchOrder) {
    const candidateMeta = join(dir, `${params.backupId}.meta.json`);
    if (existsSync(candidateMeta)) {
      metaPath = candidateMeta;
      backupDir = dir;
      foundInLegacy = legacy;
      break;
    }
  }

  if (!metaPath || !backupDir) {
    throw new CleoError(ExitCode.NOT_FOUND, `Backup not found: ${params.backupId}`);
  }

  if (foundInLegacy) emitLegacyDeprecationWarning();

  let meta: { files: string[]; timestamp: string };
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
  } catch {
    throw new CleoError(ExitCode.FILE_ERROR, 'Failed to read backup metadata');
  }

  const restored: string[] = [];
  for (const file of meta.files ?? []) {
    // T13240: the live store is never plain-copied over: `cleo restore
    // backup --id` (restoreStoreSnapshot) verifies the file, refuses live
    // writers, handles the WAL and keeps the replaced store.
    if (file === 'cleo.db' || (params.skipStoreFiles === true && STORE_FILE_LABELS.has(file)))
      continue;
    const backupFile = join(backupDir, `${file}.${params.backupId}`);
    if (!existsSync(backupFile)) continue;
    const destPath = join(cleoDir, file);
    try {
      if (file.endsWith('.db')) {
        // Atomic filesystem copy — target DB must not be in use (caller's
        // responsibility). Raw copy is safe here because no VACUUM INTO is
        // applicable (we are writing to the final location, not into a
        // snapshot).
        copyFileSync(backupFile, destPath);
      } else {
        // JSON via atomic tmp-then-rename.
        const content = readFileSync(backupFile);
        atomicWriteSync(destPath, content);
      }
      restored.push(file);
    } catch {
      // skip files that fail to restore
    }
  }

  return {
    restored: restored.length > 0,
    backupId: params.backupId,
    timestamp: meta.timestamp ?? new Date().toISOString(),
    filesRestored: restored,
  };
}

/** Result of {@link restoreBackupById}. */
export interface BackupIdRestoreResult extends RestoreResult {
  /** The store restore (`null` when the backup holds no store file). */
  store: StoreRestoreResult | null;
}

/**
 * Restore a backup by id: its store file through {@link restoreStoreSnapshot}
 * onto the live `.cleo/cleo.db` (verified, live writers refused, the replaced
 * store kept), then its JSON files as {@link restoreBackup} does (T13245).
 * The store goes first: when it is refused, nothing is restored.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param params - The backup id, the worktree confirmation and the invocation directory.
 * @returns What was restored.
 * @task T13245
 */
export async function restoreBackupById(
  projectRoot: string,
  params: {
    backupId: string;
    force?: boolean;
    confirmOwnerStore?: boolean;
    cwd: string;
    /** `global`: a backup of `<CLEO_HOME>/cleo.db` ({@link createGlobalBackup}). */
    scope?: 'project' | 'global';
  },
): Promise<BackupIdRestoreResult> {
  if (params.scope === 'global') return restoreGlobalBackupById(params);
  const cleoDir = join(projectRoot, '.cleo');
  const dirs = [
    join(cleoDir, 'backups', CANONICAL_BACKUP_SUBDIR),
    join(cleoDir, 'backups', LEGACY_BACKUP_SUBDIR),
    join(cleoDir, 'backups', 'safety'),
    join(cleoDir, 'backups', 'migration'),
  ];
  const dir = dirs.find((d) => existsSync(join(d, `${params.backupId}.meta.json`)));
  const storeFile = dir
    ? [...STORE_FILE_LABELS]
        .map((label) => join(dir, `${label}.${params.backupId}`))
        .find((p) => existsSync(p))
    : undefined;
  let store: StoreRestoreResult | null = null;
  if (storeFile) {
    const { restoreStoreSnapshot } = await import('../store/restore-store.js');
    store = await restoreStoreSnapshot({
      projectRoot,
      snapshot: storeFile,
      confirmOwnerStore: params.confirmOwnerStore,
      cwd: params.cwd,
    });
  }
  const files = restoreBackup(projectRoot, { ...params, skipStoreFiles: true });
  return {
    ...files,
    restored: files.restored || store?.restored === true,
    filesRestored: store?.restored ? ['cleo.db', ...files.filesRestored] : files.filesRestored,
    store,
  };
}

/** {@link restoreBackupById} for the global store: its one store file, no JSON (T13245). */
async function restoreGlobalBackupById(params: {
  backupId: string;
  confirmOwnerStore?: boolean;
  cwd: string;
}): Promise<BackupIdRestoreResult> {
  const dir = globalBackupDir();
  const meta = join(dir, `${params.backupId}.meta.json`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(params.backupId) || !existsSync(meta)) {
    // @sync-invariant none:input-shape no such global backup; nothing is written
    throw new CleoError(ExitCode.NOT_FOUND, `Global backup not found: ${params.backupId}`);
  }
  const { restoreStoreSnapshot } = await import('../store/restore-store.js');
  const store = await restoreStoreSnapshot({
    scope: 'global',
    projectRoot: params.cwd,
    snapshot: join(dir, `cleo.db.${params.backupId}`),
    cwd: params.cwd,
  });
  const timestamp = (JSON.parse(readFileSync(meta, 'utf-8')) as { timestamp?: string }).timestamp;
  return {
    restored: store.restored,
    backupId: params.backupId,
    timestamp: timestamp ?? new Date().toISOString(),
    filesRestored: store.restored ? ['cleo.db'] : [],
    store,
  };
}

/** Result of restoring an individual file from backup. */
export interface FileRestoreResult {
  /** Whether the file was actually restored. */
  restored: boolean;
  /** The filename that was restored. */
  file: string;
  /** The backup file path restored from. */
  from: string;
  /** The target path that was written. */
  targetPath: string;
  /** Whether this was a dry-run. */
  dryRun?: boolean;
}

/**
 * Restore an individual file (tasks.db or config.json) from the most recent backup.
 *
 * Moves the backing logic from `backupRestore` in system-engine.ts into core.
 * Uses `getTaskPath` / `getConfigPath` from `../paths.js` (respects CLEO_DIR).
 * Imports `listBackups` and `restoreFromBackup` from the store layer.
 *
 * @param projectRoot - Absolute path to the project root
 * @param fileName - File to restore: 'tasks.db' or 'config.json'
 * @param opts - Restore flags; `cwd` (the invocation directory) is required (T12680)
 * @returns Result of the restore operation
 *
 * @task T5329
 * @task T1571
 */
// SSoT-EXEMPT:engine-migration-T1571
export async function fileRestore(
  projectRoot: string,
  fileName: string,
  opts: { dryRun?: boolean; confirmOwnerStore?: boolean; cwd: string },
): Promise<FileRestoreResult> {
  const { getTaskPath, getConfigPath, getBackupDir } = await import('../paths.js');
  const { listBackups, restoreFromBackup } = await import('../store/backup.js');

  const backupDir = getBackupDir(projectRoot);

  const targetPathMap: Record<string, () => string> = {
    'tasks.db': getTaskPath,
    'config.json': getConfigPath,
  };

  const pathGetter = targetPathMap[fileName];
  if (!pathGetter) {
    throw new Error(`Unknown file: ${fileName}. Valid files: tasks.db, config.json`);
  }

  const targetPath = pathGetter();
  const backups = await listBackups(fileName, backupDir);

  if (backups.length === 0) {
    throw new Error(`No backups found for ${fileName}`);
  }

  if (opts.dryRun) {
    return { restored: false, file: fileName, from: backups[0]!, targetPath, dryRun: true };
  }

  const restoredFrom = await restoreFromBackup(fileName, backupDir, targetPath, opts);

  return { restored: true, file: fileName, from: restoredFrom, targetPath };
}
