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
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync;
};

import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';
import { getLogger } from '../logger.js';
import { getCleoDirAbsolute } from '../paths.js';
import { listSqliteBackups } from './sqlite-backup.js';
import * as schema from './tasks-schema.js';

/**
 * Open a node:sqlite DatabaseSync with CLEO standard pragmas.
 *
 * CRITICAL: WAL mode is verified, not just requested. If another process holds
 * an EXCLUSIVE lock in DELETE mode, PRAGMA journal_mode=WAL silently returns
 * 'delete'. This caused data loss (T5173) when concurrent MCP servers opened
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
  const db = new DatabaseSync(path, {
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
            `Kill other cleo/MCP processes and retry. (T5173)`,
        );
      }
    }
  }

  // Standard CLEO pragmas
  db.exec('PRAGMA foreign_keys=ON');

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
    const backupDb = new DatabaseSync(newestBackup.path, { readOnly: true });
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

    // Check if tasks.db or its WAL/SHM are dangerously tracked by git (ADR-013, T5158, T5188)
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
            // If we get here, the file IS tracked — that's dangerous
            const basename = fileToCheck.split(/[\\/]/).pop();
            log.warn(
              { path: fileToCheck },
              `${basename} is tracked by project git — this risks data loss on branch switch. ` +
                `Run: git rm --cached ${fileToCheck.replace(gitCwd + sep, '')} (see ADR-013, T5188)`,
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
 * Resolve the path to the drizzle migrations folder.
 * Works from both src/ (dev via tsx) and dist/ (compiled).
 */
export function resolveMigrationsFolder(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // Both src/store/ and dist/store/ are 2 levels deep from package root
  return join(__dirname, '..', '..', 'migrations', 'drizzle-tasks');
}

/**
 * Check whether a table exists in the SQLite database.
 */
function tableExists(nativeDb: DatabaseSync, tableName: string): boolean {
  const result = nativeDb
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(tableName) as Record<string, unknown> | undefined;
  return !!result;
}

/**
 * Check if an error is a SQLite BUSY error (database locked by another process).
 * node:sqlite throws native Error with message containing the SQLite error code.
 * @task T5185
 */
export function isSqliteBusy(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes('sqlite_busy') || msg.includes('database is locked');
}

/** Migration retry constants for SQLITE_BUSY handling (T5185). */
const MAX_MIGRATION_RETRIES = 5;
const MIGRATION_RETRY_BASE_DELAY_MS = 100;
const MIGRATION_RETRY_MAX_DELAY_MS = 2000;

/**
 * Run drizzle migrations to create/update tables.
 *
 * Handles three cases:
 * 1. New database — runs all migrations from scratch.
 * 2. Existing database created by legacy createTablesIfNeeded() — bootstraps
 *    the baseline migration as already applied, then runs remaining migrations.
 * 3. Already-migrated database — runs only pending migrations.
 *
 * BEGIN IMMEDIATE acquires a RESERVED lock upfront, preventing concurrent
 * migration runners from racing (T5173). If another process already holds a
 * RESERVED lock, BEGIN IMMEDIATE throws SQLITE_BUSY. This function retries
 * with exponential backoff + jitter to handle concurrent MCP server starts (T5185).
 *
 * @task T4837 - ADR-012 drizzle-kit migration system
 * @task T5185 - Retry+backoff for SQLITE_BUSY during migrations
 */
function runMigrations(
  nativeDb: DatabaseSync,
  db: NodeSQLiteDatabase<typeof schema>,
): void {
  const migrationsFolder = resolveMigrationsFolder();

  // Bootstrap existing databases that predate drizzle migrations (ADR-012 Step D).
  // These have tables (e.g., 'tasks') but no __drizzle_migrations record.
  // Mark the baseline migration as already applied so migrate() doesn't
  // try to re-create existing tables.
  if (tableExists(nativeDb, 'tasks') && !tableExists(nativeDb, '__drizzle_migrations')) {
    const migrations = readMigrationFiles({ migrationsFolder });
    const baseline = migrations[0];
    if (baseline) {
      nativeDb.exec(`
        CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
          id SERIAL PRIMARY KEY,
          hash text NOT NULL,
          created_at numeric
        )
      `);
      nativeDb.exec(
        `INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES ('${baseline.hash}', ${baseline.folderMillis})`,
      );
    }
  }

  // Run pending migrations via drizzle-orm/node-sqlite/migrator (synchronous).
  // The new migrator handles its own transactions. T5185: retry on SQLITE_BUSY.
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_MIGRATION_RETRIES; attempt++) {
    try {
      migrate(db, { migrationsFolder });
      return;
    } catch (err) {
      if (!isSqliteBusy(err) || attempt === MAX_MIGRATION_RETRIES) {
        throw err;
      }
      lastError = err;
      const delay = Math.min(
        MIGRATION_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) * (1 + Math.random() * 0.5),
        MIGRATION_RETRY_MAX_DELAY_MS,
      );
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.round(delay));
    }
  }
  /* c8 ignore next */
  throw lastError;
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

/**
 * Re-export schema for external use.
 */
export { schema };
export type { NodeSQLiteDatabase };

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
    const { closeBrainDb } = await import('./brain-sqlite.js');
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
