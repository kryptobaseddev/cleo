/**
 * SQLite store via drizzle-orm/node-sqlite + node:sqlite (DatabaseSync).
 *
 * Zero native npm dependencies, 100% cross-platform (Windows/Linux/macOS).
 * File-backed SQLite with WAL mode for multi-process concurrent access.
 * Database stored at .cleo/tasks.db.
 *
 * Architecture: node:sqlite provides the synchronous file-backed SQLite engine,
 * wrapped via drizzle-orm/node-sqlite for a fully synchronous interface. All
 * writes go directly to disk through SQLite's native WAL mechanism -- no
 * saveToFile() pattern needed.
 *
 * @epic T4454
 * @task T4817 - node:sqlite engine migration (ADR-006, ADR-010)
 * @task T4810 - Data loss prevention guards
 */

import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
// underscore-import: node:sqlite type alias is required for createRequire interop.
// Vitest/Vite cannot resolve `node:sqlite` as an ESM import (strips `node:` prefix).
// Use createRequire as the runtime loader; keep type-only import for annotations.
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';

const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;

/**
 * Lazy-loaded node:sqlite DatabaseSync constructor.
 * Moved from module-scope destructuring to function-scope to break a TDZ
 * circular-import cycle: agent-resolver → dispatch-trace → extraction-gate
 * → graph-auto-populate → memory-sqlite → sqlite.ts (T1325/T1331).
 *
 * The module-scope `const { DatabaseSync } = _require(...)` was executed
 * before the module finished initializing when Vitest eagerly traced the
 * dynamic `import('../memory/dispatch-trace.js')` in agent-resolver.ts,
 * causing a TDZ ReferenceError. Deferring the require() call to first use
 * avoids the re-entrant initialization.
 */
let _DatabaseSyncCtor:
  | (new (
      ...args: ConstructorParameters<typeof _DatabaseSyncType>
    ) => DatabaseSync)
  | null = null;
function getDbSyncConstructor(): new (
  ...args: ConstructorParameters<typeof _DatabaseSyncType>
) => DatabaseSync {
  if (_DatabaseSyncCtor === null) {
    const mod = _require('node:sqlite') as {
      DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync;
    };
    _DatabaseSyncCtor = mod.DatabaseSync;
  }
  return _DatabaseSyncCtor;
}

import { dirname, join, resolve, sep } from 'node:path';
import { eq } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { getLogger } from '../logger.js';
import { getCleoDirAbsolute } from '../paths.js';
import {
  createSafetyBackup,
  ensureColumns,
  migrateWithRetry,
  reconcileJournal,
  tableExists,
} from './migration-manager.js';
import { resolveCorePackageMigrationsFolder } from './resolve-migrations-folder.js';
import { listSqliteBackups } from './sqlite-backup.js';
import * as schema from './tasks-schema.js';

/**
 * Open a node:sqlite DatabaseSync with CLEO standard pragmas.
 *
 * CRITICAL: WAL mode is verified, not just requested. If another process holds
 * an EXCLUSIVE lock in DELETE mode, PRAGMA journal_mode=WAL silently returns
 * 'delete'. This caused data loss (T5173) when concurrent processes opened
 * the same database — writes were silently dropped under lock contention.
 */
export function openNativeDatabase(
  path: string,
  options?: {
    readonly?: boolean;
    timeout?: number;
    enableWal?: boolean;
    allowExtension?: boolean;
  },
): DatabaseSync {
  const DatabaseSyncCtor = getDbSyncConstructor();
  const db = new DatabaseSyncCtor(path, {
    enableForeignKeyConstraints: true,
    readOnly: options?.readonly ?? false,
    timeout: options?.timeout ?? 5000,
    allowExtension: options?.allowExtension ?? false,
  });

  // Set busy_timeout FIRST so WAL pragma can wait for locks
  db.exec('PRAGMA busy_timeout=5000');

  // Enable WAL for concurrent multi-process access (ADR-006, ADR-010)
  if (options?.enableWal !== false) {
    const MAX_WAL_RETRIES = 3;
    const RETRY_DELAY_MS = 200;
    let walSet = false;

    for (let attempt = 1; attempt <= MAX_WAL_RETRIES; attempt++) {
      db.exec('PRAGMA journal_mode=WAL');

      // CRITICAL: Verify WAL was actually set — the PRAGMA returns the mode
      // that was applied, which may be 'delete' if another connection holds a lock
      const result = db.prepare('PRAGMA journal_mode').get() as Record<string, unknown> | undefined;
      const currentMode = (result?.journal_mode as string)?.toLowerCase?.() ?? 'unknown';

      if (currentMode === 'wal') {
        walSet = true;
        break;
      }

      // WAL not set — another connection likely holds an EXCLUSIVE lock
      if (attempt < MAX_WAL_RETRIES) {
        // Sync sleep via Atomics for retry delay (node:sqlite is sync-only)
        const buf = new SharedArrayBuffer(4);
        Atomics.wait(new Int32Array(buf), 0, 0, RETRY_DELAY_MS * attempt);
      }
    }

    if (!walSet) {
      // Verify one final time
      const finalResult = db.prepare('PRAGMA journal_mode').get() as
        | Record<string, unknown>
        | undefined;
      const finalMode = (finalResult?.journal_mode as string)?.toLowerCase?.() ?? 'unknown';

      if (finalMode !== 'wal') {
        db.close();
        throw new Error(
          `CRITICAL: Failed to set WAL journal mode after ${MAX_WAL_RETRIES} attempts. ` +
            `Database is in '${finalMode}' mode. Another process likely holds an EXCLUSIVE lock ` +
            `on ${path}. Refusing to open — concurrent writes in DELETE mode cause data loss. ` +
            `Kill other cleo processes and retry. (T5173)`,
        );
      }
    }
  }

  // FK enforcement enabled in production. Disabled in vitest where test
  // fixtures insert data without full referential integrity (orphan refs).
  // VITEST env var is auto-set by vitest — no config needed.
  if (!process.env.VITEST) {
    db.exec('PRAGMA foreign_keys=ON');
  }

  return db;
}

/** Database file name within .cleo/ directory. */
const DB_FILENAME = 'tasks.db';

/** Schema version for newly created databases. Single source of truth. */
export const SQLITE_SCHEMA_VERSION = '2.0.0';
const SCHEMA_VERSION = SQLITE_SCHEMA_VERSION;

/** Singleton state for lazy initialization. */
let _db: NodeSQLiteDatabase<typeof schema> | null = null;
let _nativeDb: DatabaseSync | null = null;
let _dbPath: string | null = null;
/** Guard against concurrent initialization (async migration). */
let _initPromise: Promise<NodeSQLiteDatabase<typeof schema>> | null = null;
/** Guard: git-tracking check runs only once per process. */
let _gitTrackingChecked = false;

/**
 * Get the path to the SQLite database file.
 */
export function getDbPath(cwd?: string): string {
  return join(getCleoDirAbsolute(cwd), DB_FILENAME);
}

/**
 * Minimum task count in a backup to consider it a valid recovery source.
 * Prevents restoring from a backup that's also empty or nearly empty.
 * @task T5188
 */
const MIN_BACKUP_TASK_COUNT = 10;

/**
 * Auto-recover from backup if the database has tables but zero tasks
 * and a backup with data exists.
 *
 * Root cause (T5188): WAL/SHM files were tracked by git. On branch switch,
 * git overwrites the WAL with an empty (committed) version, discarding all
 * pending WAL writes. The main DB file (which may not have been checkpointed)
 * appears empty because all recent writes were in the WAL.
 *
 * This function runs after migrations (so tables exist) and before the
 * singleton is set. It checks if the tasks table is empty and a VACUUM INTO
 * backup exists with real data. If so, it closes the current connection,
 * replaces the DB file from backup, and re-opens.
 *
 * @task T5188
 */
async function autoRecoverFromBackup(
  nativeDb: DatabaseSync,
  dbPath: string,
  cwd: string | undefined,
): Promise<void> {
  const log = getLogger('sqlite');

  try {
    // Count tasks in current database
    const countResult = nativeDb.prepare('SELECT COUNT(*) as cnt FROM tasks').get() as
      | { cnt: number }
      | undefined;
    const taskCount = countResult?.cnt ?? 0;

    if (taskCount > 0) return; // Database has data, no recovery needed

    // Database is empty — check for backups
    const backups = listSqliteBackups(cwd);
    if (backups.length === 0) {
      // No backups available — this is a genuinely new database
      return;
    }

    // Check the newest backup for task count
    const newestBackup = backups[0]!;

    // Open backup read-only to verify it has data
    const DatabaseSyncCtor = getDbSyncConstructor();
    const backupDb = new DatabaseSyncCtor(newestBackup.path, { readOnly: true });
    let backupTaskCount = 0;
    try {
      const backupCount = backupDb.prepare('SELECT COUNT(*) as cnt FROM tasks').get() as
        | { cnt: number }
        | undefined;
      backupTaskCount = backupCount?.cnt ?? 0;
    } finally {
      backupDb.close();
    }

    if (backupTaskCount < MIN_BACKUP_TASK_COUNT) {
      // Backup also has very few tasks — not a reliable recovery source
      return;
    }

    // We have an empty database AND a backup with data — auto-recover
    log.warn(
      { dbPath, backupPath: newestBackup.path, backupTasks: backupTaskCount },
      `Empty database detected with ${backupTaskCount}-task backup available. ` +
        'Auto-recovering from backup. This likely happened because git-tracked ' +
        'WAL/SHM files were overwritten during a branch switch (T5188).',
    );

    // Close current connection
    nativeDb.close();

    // Remove stale WAL/SHM files that may have been corrupted by git
    const walPath = dbPath + '-wal';
    const shmPath = dbPath + '-shm';
    try {
      unlinkSync(walPath);
    } catch {
      /* may not exist */
    }
    try {
      unlinkSync(shmPath);
    } catch {
      /* may not exist */
    }

    // Restore from backup (atomic: copy to temp, rename)
    const tempPath = dbPath + '.recovery-tmp';
    copyFileSync(newestBackup.path, tempPath);

    // Rename in place — on the same filesystem this is atomic
    renameSync(tempPath, dbPath);

    log.info(
      { dbPath, backupPath: newestBackup.path, restoredTasks: backupTaskCount },
      'Database auto-recovered from backup successfully.',
    );

    // Re-open the restored database — update the native singleton
    const restoredNativeDb = openNativeDatabase(dbPath);
    _nativeDb = restoredNativeDb;

    // Re-run migrations on restored DB to ensure schema is current
    const restoredDb = drizzle({ client: restoredNativeDb, schema });
    runMigrations(restoredNativeDb, restoredDb);

    // Update the singleton drizzle instance
    _db = restoredDb;
  } catch (err) {
    // Auto-recovery failure is non-fatal — log and continue with empty DB
    log.error({ err, dbPath }, 'Auto-recovery from backup failed. Continuing with empty database.');
  }
}

/**
 * Initialize the SQLite database (lazy, singleton).
 * Creates the database file and tables if they don't exist.
 * Returns the drizzle ORM instance (node-sqlite driver).
 *
 * Uses a promise guard so concurrent callers wait for the same
 * initialization to complete (migrations are async).
 */
export async function getDb(cwd?: string): Promise<NodeSQLiteDatabase<typeof schema>> {
  const requestedPath = getDbPath(cwd);

  // If singleton exists but points to different path, reset it
  if (_db && _dbPath !== requestedPath) {
    resetDbState();
  }

  if (_db) return _db;

  // If already initializing, wait for the in-flight init
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const dbPath = requestedPath;
    _dbPath = dbPath;

    // Ensure directory exists
    mkdirSync(dirname(dbPath), { recursive: true });

    // Open file-backed SQLite via node:sqlite with WAL mode
    const nativeDb = openNativeDatabase(dbPath);
    _nativeDb = nativeDb;

    // Create drizzle ORM wrapper via node-sqlite
    const db = drizzle({ client: nativeDb, schema });

    // Run drizzle migrations (creates/updates tables)
    runMigrations(nativeDb, db);

    // Migration SQL contains PRAGMA foreign_keys=ON statements.
    // In test environments, disable FKs after migration to allow test
    // fixtures to insert data without full referential integrity.
    if (process.env.VITEST) {
      nativeDb.exec('PRAGMA foreign_keys=OFF');
    }

    // Seed schema version for new databases (no-op if already set)
    nativeDb.exec(
      `INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('schemaVersion', '${SCHEMA_VERSION}')`,
    );
    nativeDb.exec(
      `INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('task_id_sequence', '{"counter":0,"lastId":"T000","checksum":"seed"}')`,
    );

    // Auto-recovery: detect empty database with available backups (T5188)
    // Root cause: git-tracked WAL/SHM files get overwritten on branch switch,
    // causing data loss when the WAL contained uncommitted writes.
    await autoRecoverFromBackup(nativeDb, dbPath, cwd);

    // Check if tasks.db or its WAL/SHM are dangerously tracked by git (ADR-013, T5158, T5188).
    //
    // As of ADR-013 §9 (2026-04-07) the canonical resolution is:
    //   1. `.cleo/tasks.db` + WAL/SHM and `.cleo/brain.db` + WAL/SHM are
    //      git-ignored at the project root and untracked via `git rm --cached`.
    //   2. Recovery is provided by VACUUM INTO snapshots in
    //      `.cleo/backups/sqlite/` (auto-rotated, 10 per DB, refreshed on
    //      every `cleo session end` via the backup-session-end hook).
    //   3. Full 4-file snapshots (including config.json + project-info.json)
    //      are created on demand via `cleo backup add` / listed via
    //      `cleo backup list` / restored via `cleo restore backup`.
    //
    // The warning below is retained as a regression guard: if someone
    // accidentally re-stages the DB into project git, this warning fires at
    // every process startup so they fix it before real data loss occurs.
    if (!_gitTrackingChecked) {
      _gitTrackingChecked = true;
      try {
        const { execFileSync } = await import('node:child_process');
        const gitCwd = resolve(dbPath, '..', '..');
        const filesToCheck = [dbPath, dbPath + '-wal', dbPath + '-shm'];
        const log = getLogger('sqlite');

        for (const fileToCheck of filesToCheck) {
          try {
            execFileSync('git', ['ls-files', '--error-unmatch', fileToCheck], {
              cwd: gitCwd,
              stdio: 'pipe',
            });
            // If we get here, the file IS tracked — that's dangerous.
            const basename = fileToCheck.split(/[\\/]/).pop();
            const relPath = fileToCheck.replace(gitCwd + sep, '');
            log.warn(
              { path: fileToCheck },
              `${basename} is tracked by project git — this risks data loss on branch switch. ` +
                `Resolution (ADR-013 §9): \`git rm --cached ${relPath}\` and rely on ` +
                `\`.cleo/backups/sqlite/\` snapshots + \`cleo backup add\` for recovery.`,
            );
          } catch {
            // Exit code 1 = not tracked = good
          }
        }
      } catch {
        // git not available, skip check
      }
    }

    // Set singleton only after migrations complete
    _db = db;
    return db;
  })();

  try {
    return await _initPromise;
  } finally {
    _initPromise = null;
  }
}

/**
 * Resolve the absolute path to the drizzle-tasks migrations folder inside
 * @cleocode/core, using ESM-native module resolution (T1177).
 *
 * Delegates to {@link resolveCorePackageMigrationsFolder} which handles
 * bundled dist/, workspace dev, and global-install layouts uniformly via
 * `import.meta.resolve()` + `createRequire().resolve()` fallback.
 */
export function resolveMigrationsFolder(): string {
  return resolveCorePackageMigrationsFolder('drizzle-tasks');
}

/**
 * Check whether a table exists in the SQLite database.
 */
// tableExists, isSqliteBusy, retry constants — delegated to migration-manager.ts (T132)

/** Re-export isSqliteBusy for external consumers. */
export { isSqliteBusy } from './migration-manager.js';

/**
 * Required columns that MUST exist on the tasks table.
 * Only TEXT columns with no constraints are safe for ALTER TABLE ADD in SQLite.
 * @see https://github.com/anthropics/cleo/issues/63
 */
import type { RequiredColumn } from './migration-manager.js';

const REQUIRED_TASK_COLUMNS: RequiredColumn[] = [
  { name: 'pipeline_stage', ddl: 'text' },
  { name: 'assignee', ddl: 'text' },
];

/**
 * Required columns that MUST exist on the sessions table before the
 * wave0-schema-hardening migration runs.
 *
 * The wave0 migration rebuilds the sessions table via:
 *   INSERT INTO __new_sessions(..., provider_id, stats_json, resume_count, grade_mode)
 *   SELECT ..., provider_id, stats_json, resume_count, grade_mode FROM sessions
 *
 * If an existing sessions table (created before these columns were added) is
 * missing any of them, the SELECT fails with "no such column". ensureColumns()
 * adds them as NULL-able columns before the migration runs, making the SELECT safe.
 *
 * @see https://github.com/anthropics/cleo/issues/83
 */
const REQUIRED_SESSION_COLUMNS: RequiredColumn[] = [
  { name: 'provider_id', ddl: 'text' },
  { name: 'stats_json', ddl: 'text' },
  { name: 'resume_count', ddl: 'integer' },
  { name: 'grade_mode', ddl: 'integer' },
  // T1118 L4a — owner-auth HMAC token for override authentication
  { name: 'owner_auth_token', ddl: 'text' },
];

/**
 * Run drizzle migrations to create/update tables.
 *
 * Delegates to shared migration-manager.ts for journal reconciliation,
 * retry logic, and column safety. See T132 for consolidation rationale.
 *
 * @task T4837 - ADR-012 drizzle-kit migration system
 * @task T5185 - Retry+backoff for SQLITE_BUSY during migrations
 * @task T132 - Unified migration system
 */
function runMigrations(nativeDb: DatabaseSync, db: NodeSQLiteDatabase<typeof schema>): void {
  const migrationsFolder = resolveMigrationsFolder();

  // Safety backup before any migration work
  if (tableExists(nativeDb, 'tasks') && _dbPath) {
    createSafetyBackup(_dbPath);
  }

  // Bootstrap baseline + reconcile stale journal entries
  reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'sqlite');

  // Pre-migration column safety: ensure sessions table has the columns that the
  // wave0-schema-hardening migration SELECTs during its table rebuild. Without
  // this, upgrading from a pre-wave0 DB fails with "no such column: provider_id".
  // Must run BEFORE migrateWithRetry so the migration's INSERT...SELECT succeeds.
  // @see https://github.com/anthropics/cleo/issues/83
  ensureColumns(nativeDb, 'sessions', REQUIRED_SESSION_COLUMNS, 'sqlite');

  // Run pending migrations with SQLITE_BUSY retry.
  // Pass nativeDb + existenceTable so migrateWithRetry can auto-reconcile any
  // partial migration (Scenario 3) that slips through the proactive check above.
  migrateWithRetry(db, migrationsFolder, nativeDb, 'tasks', 'sqlite');

  // Defensive column safety net
  ensureColumns(nativeDb, 'tasks', REQUIRED_TASK_COLUMNS, 'sqlite');
}

/**
 * Close the database connection and release resources.
 */
export function closeDb(): void {
  if (_nativeDb) {
    try {
      if (_nativeDb.isOpen) {
        _nativeDb.close();
      }
    } catch {
      // Ignore close errors
    }
    _nativeDb = null;
  }
  _db = null;
  _dbPath = null;
  _initPromise = null;
}

/**
 * Reset database singleton state without saving.
 * Used during migrations when database file is deleted and recreated.
 * Safe to call multiple times.
 */
export function resetDbState(): void {
  if (_nativeDb) {
    try {
      if (_nativeDb.isOpen) {
        _nativeDb.close();
      }
    } catch {
      // Ignore close errors
    }
    _nativeDb = null;
  }
  _db = null;
  _dbPath = null;
  _initPromise = null;
}

/**
 * Get the schema version from the database.
 */
export async function getSchemaVersion(cwd?: string): Promise<string | null> {
  const db = await getDb(cwd);
  const result = await db
    .select()
    .from(schema.schemaMeta)
    .where(eq(schema.schemaMeta.key, 'schemaVersion'));

  return result[0]?.value ?? null;
}

/**
 * Check if the database file exists.
 */
export function dbExists(cwd?: string): boolean {
  return existsSync(getDbPath(cwd));
}

/**
 * Get the underlying node:sqlite DatabaseSync instance.
 * Useful for direct PRAGMA calls or raw SQL operations.
 * Returns null if the database hasn't been initialized.
 */
export function getNativeDb(): DatabaseSync | null {
  return _nativeDb;
}

/**
 * Get the underlying node:sqlite DatabaseSync instance for tasks.db.
 * Alias for getNativeDb() — mirrors getBrainNativeDb() naming convention.
 */
export function getNativeTasksDb(): DatabaseSync | null {
  return _nativeDb;
}

export type { NodeSQLiteDatabase };
/**
 * Re-export schema for external use.
 */
export { schema };

/**
 * Close ALL database singletons (tasks.db, brain.db, nexus.db).
 *
 * Must be called before deleting temp directories on Windows, where
 * SQLite holds exclusive file handles on .db, .db-wal, and .db-shm files.
 * Safe to call even if some databases were never opened.
 *
 * @task T5508
 */
export async function closeAllDatabases(): Promise<void> {
  // Close tasks.db
  closeDb();

  // Close brain.db (dynamic import to avoid circular deps)
  try {
    const { closeBrainDb } = await import('./memory-sqlite.js');
    closeBrainDb();
  } catch {
    /* module may not be loaded */
  }

  // Close nexus.db (dynamic import to avoid circular deps)
  try {
    const { closeNexusDb } = await import('./nexus-sqlite.js');
    closeNexusDb();
  } catch {
    /* module may not be loaded */
  }
}
