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
 *   - JSON files: atomic tmp-then-rename via {@link atomicWrite} so a partial
 *     write can never corrupt the backup target.
 *
 * Snapshots are recorded under `.cleo/backups/{type}/` with a JSON sidecar
 * (`{backupId}.meta.json`) enumerating which files were captured and how.
 * Restores read the same sidecars and materialize each file back into the
 * live `.cleo/` directory.
 *
 * This is the backing store for the `cleo backup` and `cleo restore backup`
 * CLI verbs (see packages/cleo/src/cli/commands/backup.ts and restore.ts).
 *
 * @task T4783
 * @task T5158 — extended to use VACUUM INTO for .db files and atomicWrite for JSON
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../errors.js';
import { getBrainNativeDb } from '../store/memory-sqlite.js';
import { getNativeDb } from '../store/sqlite.js';

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
 * (for JSON) into `.cleo/backups/{type}/`. Writes a `{backupId}.meta.json`
 * sidecar describing the snapshot.
 *
 * Opens both `tasks.db` and `brain.db` through their canonical drizzle
 * accessors before snapshotting so that the native DB handles are live
 * when `safeSqliteSnapshot` asks for them. This makes the function
 * self-contained — callers do not need to pre-open the DBs.
 *
 * Async because opening the database engines requires async migration
 * reconciliation (ADR-012). The CLI dispatch layer awaits this result.
 */
export async function createBackup(
  projectRoot: string,
  opts?: { type?: string; note?: string },
): Promise<BackupResult> {
  const cleoDir = join(projectRoot, '.cleo');
  const btype = opts?.type || 'snapshot';
  const timestamp = new Date().toISOString();
  const backupId = `${btype}-${timestamp.replace(/[:.]/g, '-')}`;
  const backupDir = join(cleoDir, 'backups', btype);

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
}

/**
 * List all available system backups (snapshot, safety, migration types).
 * Reads `.meta.json` sidecar files written by createBackup.
 * This is a pure read operation — it does not modify any files.
 * @task T4783
 */
export function listSystemBackups(projectRoot: string): BackupEntry[] {
  const cleoDir = join(projectRoot, '.cleo');
  const backupTypes = ['snapshot', 'safety', 'migration'];
  const entries: BackupEntry[] = [];

  for (const btype of backupTypes) {
    const backupDir = join(cleoDir, 'backups', btype);
    if (!existsSync(backupDir)) continue;
    try {
      const files = readdirSync(backupDir).filter((f) => f.endsWith('.meta.json'));
      for (const metaFile of files) {
        try {
          const raw = readFileSync(join(backupDir, metaFile), 'utf-8');
          const meta = JSON.parse(raw) as Partial<BackupEntry>;
          if (meta.backupId && meta.timestamp) {
            entries.push({
              backupId: meta.backupId,
              type: meta.type ?? btype,
              timestamp: meta.timestamp,
              note: meta.note,
              files: meta.files ?? [],
            });
          }
        } catch {
          // skip malformed meta files
        }
      }
    } catch {
      // skip unreadable backup directories
    }
  }

  // Sort newest first
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
 */
export function restoreBackup(
  projectRoot: string,
  params: { backupId: string; force?: boolean },
): RestoreResult {
  if (!params.backupId) {
    throw new CleoError(ExitCode.INVALID_INPUT, 'backupId is required');
  }

  const cleoDir = join(projectRoot, '.cleo');
  const backupTypes = ['snapshot', 'safety', 'migration'];
  let metaPath: string | null = null;
  let backupDir: string | null = null;

  for (const btype of backupTypes) {
    const candidateMeta = join(cleoDir, 'backups', btype, `${params.backupId}.meta.json`);
    if (existsSync(candidateMeta)) {
      metaPath = candidateMeta;
      backupDir = join(cleoDir, 'backups', btype);
      break;
    }
  }

  if (!metaPath || !backupDir) {
    throw new CleoError(ExitCode.NOT_FOUND, `Backup not found: ${params.backupId}`);
  }

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
