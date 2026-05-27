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
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../errors.js';
import { getBrainNativeDb } from '../store/memory-sqlite.js';
import { getNativeDb } from '../store/sqlite.js';

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

/**
 * Format a Date as `YYYYMMDD-HHmmss` (local time) — mirrors the helper of
 * the same name in `sqlite-backup.ts` so both auto-snapshot and manual
 * snapshot files in `.cleo/backups/sqlite/` share one timestamp convention.
 *
 * @task T10315 — unified with `sqlite-backup.ts:formatTimestamp`.
 */
function formatTimestamp(d: Date): string {
  const pad = (n: number, len = 2): string => String(n).padStart(len, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/**
 * Rotate backups in a directory: delete the oldest files until
 * fewer than `maxSnapshots` non-meta files remain.
 *
 * Only rotates files matching the `createBackup` filename scheme
 * (`<file>.<type>-YYYYMMDD-HHmmss` for the canonical timestamp shape OR
 * `<file>.<type>-<iso-with-dashes>` for backward compatibility) so it never
 * touches files produced by `vacuumIntoBackupAll` in the same directory.
 * Non-fatal — filesystem errors are silently swallowed.
 *
 * @task T9194
 * @task T10315 — added scoping predicate so rotation never reaches
 *                vacuum-snapshot files that share `.cleo/backups/sqlite/`.
 */
function rotateBackupDir(backupDir: string, maxSnapshots: number, backupType: string): void {
  try {
    // Match `<anything>.${backupType}-<timestamp>` where timestamp is either
    // canonical (`YYYYMMDD-HHmmss`) or legacy-ISO (`YYYY-MM-DDTHH-MM-SS-mmmZ`).
    // Excludes:
    //   - `.meta.json` sidecars (filtered explicitly below)
    //   - `.tmp` partial writes
    //   - vacuum-snapshot files (`tasks-YYYYMMDD-HHmmss.db`, `brain-...`) —
    //     those start with the prefix, not `.<file>.${backupType}-`.
    const escapedType = backupType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const ownedPattern = new RegExp(`\\.${escapedType}-`);
    const files = readdirSync(backupDir)
      .filter((f) => !f.endsWith('.meta.json') && !f.endsWith('.tmp') && ownedPattern.test(f))
      .map((f) => ({
        name: f,
        path: join(backupDir, f),
        mtimeMs: statSync(join(backupDir, f)).mtimeMs,
      }))
      .sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first

    while (files.length > maxSnapshots) {
      const oldest = files.shift();
      if (!oldest) break;
      try {
        unlinkSync(oldest.path);
        // Also delete the corresponding .meta.json sidecar if it exists.
        const metaPath = `${oldest.path}.meta.json`;
        if (existsSync(metaPath)) unlinkSync(metaPath);
      } catch {
        /* non-fatal */
      }
    }
  } catch {
    // non-fatal — rotation failures must never block the backup operation
  }
}

/** Safe wrapper around VACUUM INTO: flushes WAL then clones the DB. */
function safeSqliteSnapshot(db: { exec: (sql: string) => void } | null, destPath: string): boolean {
  if (!db) return false;
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const safeDest = destPath.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${safeDest}'`);
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
  const backupId = `${btype}-${formatTimestamp(now)}`;
  const backupDir = join(cleoDir, 'backups', CANONICAL_BACKUP_SUBDIR);

  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true });
  }

  // Ensure both SQLite engines are initialized so getNativeDb/
  // getBrainNativeDb return live handles when we call them below. Both
  // opens are best-effort — if one fails we still snapshot whatever we
  // can reach (plus the JSON files). Dynamic imports avoid pulling
  // drizzle into test suites that mock the store layer.
  try {
    const { getDb } = await import('../store/sqlite.js');
    await getDb(projectRoot);
  } catch {
    // tasks.db open failed — will be skipped by the sqlite target below
  }
  try {
    const { getBrainDb } = await import('../store/memory-sqlite.js');
    await getBrainDb(projectRoot);
  } catch {
    // brain.db open failed — will be skipped by the sqlite target below
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
    { file: 'tasks.db', getDb: getNativeDb },
    { file: 'brain.db', getDb: getBrainNativeDb },
  ];
  const jsonTargets: string[] = ['config.json', 'project-info.json'];
  const backedUp: string[] = [];

  // SQLite via VACUUM INTO.
  for (const target of sqliteTargets) {
    const src = join(cleoDir, target.file);
    if (!existsSync(src)) continue;
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
}

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
  params: { backupId: string; force?: boolean },
): RestoreResult {
  if (!params.backupId) {
    throw new CleoError(ExitCode.INVALID_INPUT, 'backupId is required');
  }

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
 * @param opts - Optional restore flags
 * @returns Result of the restore operation
 *
 * @task T5329
 * @task T1571
 */
// SSoT-EXEMPT:engine-migration-T1571
export async function fileRestore(
  projectRoot: string,
  fileName: string,
  opts?: { dryRun?: boolean },
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

  if (opts?.dryRun) {
    return { restored: false, file: fileName, from: backups[0]!, targetPath, dryRun: true };
  }

  const restoredFrom = await restoreFromBackup(fileName, backupDir, targetPath);

  return { restored: true, file: fileName, from: restoredFrom, targetPath };
}
