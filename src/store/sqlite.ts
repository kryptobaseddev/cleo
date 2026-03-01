/**
 * SQLite store via drizzle-orm/sqlite-proxy + node:sqlite (DatabaseSync).
 *
 * Zero native npm dependencies, 100% cross-platform (Windows/Linux/macOS).
 * File-backed SQLite with WAL mode for multi-process concurrent access.
 * Database stored at .cleo/tasks.db.
 *
 * Architecture: node:sqlite provides the synchronous file-backed SQLite engine,
 * wrapped via sqlite-proxy to give drizzle-orm an async interface. All writes
 * go directly to disk through SQLite's native WAL mechanism -- no saveToFile()
 * pattern needed.
 *
 * @epic T4454
 * @task T4817 - node:sqlite engine migration (ADR-006, ADR-010)
 * @task T4810 - Data loss prevention guards
 */

import { existsSync, mkdirSync } from 'node:fs';
// Vitest/Vite cannot resolve `node:sqlite` as an ESM import (strips `node:` prefix).
// Use createRequire as the runtime loader; keep type-only import for annotations.
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as { DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync };
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { migrate } from 'drizzle-orm/sqlite-proxy/migrator';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import * as schema from './schema.js';
import { getCleoDirAbsolute } from '../core/paths.js';
import { openNativeDatabase, createDrizzleCallback, createBatchCallback } from './node-sqlite-adapter.js';
import { getLogger } from '../core/logger.js';

/** Database file name within .cleo/ directory. */
const DB_FILENAME = 'tasks.db';

/** Schema version for newly created databases. Single source of truth. */
export const SQLITE_SCHEMA_VERSION = '2.0.0';
const SCHEMA_VERSION = SQLITE_SCHEMA_VERSION;

/** Singleton state for lazy initialization. */
let _db: SqliteRemoteDatabase<typeof schema> | null = null;
let _nativeDb: DatabaseSync | null = null;
let _dbPath: string | null = null;
/** Guard against concurrent initialization (async migration). */
let _initPromise: Promise<SqliteRemoteDatabase<typeof schema>> | null = null;
/** Guard: git-tracking check runs only once per process. */
let _gitTrackingChecked = false;

/**
 * Get the path to the SQLite database file.
 */
export function getDbPath(cwd?: string): string {
  return join(getCleoDirAbsolute(cwd), DB_FILENAME);
}

/**
 * Initialize the SQLite database (lazy, singleton).
 * Creates the database file and tables if they don't exist.
 * Returns the drizzle ORM instance (async via sqlite-proxy).
 *
 * Uses a promise guard so concurrent callers wait for the same
 * initialization to complete (migrations are async).
 */
export async function getDb(cwd?: string): Promise<SqliteRemoteDatabase<typeof schema>> {
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

    // Create drizzle ORM wrapper via sqlite-proxy
    const callback = createDrizzleCallback(nativeDb);
    const batchCb = createBatchCallback(nativeDb);
    const db = drizzle(callback, batchCb, { schema });

    // Run drizzle migrations (creates/updates tables)
    await runMigrations(nativeDb, db);

    // Seed schema version for new databases (no-op if already set)
    nativeDb.exec(
      `INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('schemaVersion', '${SCHEMA_VERSION}')`,
    );
    nativeDb.exec(
      `INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('task_id_sequence', '{"counter":0,"lastId":"T000","checksum":"seed"}')`,
    );

    // Check if tasks.db is dangerously tracked by git (ADR-013, T5158)
    if (!_gitTrackingChecked) {
      _gitTrackingChecked = true;
      try {
        const { execFileSync } = await import('node:child_process');
        execFileSync('git', ['ls-files', '--error-unmatch', dbPath], {
          cwd: resolve(dbPath, '..', '..'),
          stdio: 'pipe',
        });
        // If we get here, the file IS tracked — that's dangerous
        const log = getLogger('sqlite');
        log.warn(
          { dbPath },
          'tasks.db is tracked by project git — this risks data loss on git operations. Run: git rm --cached .cleo/tasks.db (see ADR-013)',
        );
      } catch {
        // Exit code 1 = not tracked = good, do nothing
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
  return join(__dirname, '..', '..', 'drizzle');
}

/**
 * Check whether a table exists in the SQLite database.
 */
function tableExists(nativeDb: DatabaseSync, tableName: string): boolean {
  const result = nativeDb.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
  ).get(tableName) as Record<string, unknown> | undefined;
  return !!result;
}

/**
 * Run drizzle migrations to create/update tables.
 *
 * Handles three cases:
 * 1. New database — runs all migrations from scratch.
 * 2. Existing database created by legacy createTablesIfNeeded() — bootstraps
 *    the baseline migration as already applied, then runs remaining migrations.
 * 3. Already-migrated database — runs only pending migrations.
 *
 * @task T4837 - ADR-012 drizzle-kit migration system
 */
async function runMigrations(
  nativeDb: DatabaseSync,
  db: SqliteRemoteDatabase<typeof schema>,
): Promise<void> {
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

  // Run pending migrations via drizzle-orm/sqlite-proxy/migrator.
  // Each batch of queries (one migration) is wrapped in an explicit transaction.
  // drizzle appends INSERT INTO __drizzle_migrations as the final query in the
  // batch. Without a transaction, a failed CREATE TABLE leaves the hash
  // unrecorded, causing the same migration to re-run and crash on every startup.
  await migrate(db, async (queries: string[]) => {
    nativeDb.prepare('BEGIN').run();
    try {
      for (const query of queries) {
        nativeDb.prepare(query).run();
      }
      nativeDb.prepare('COMMIT').run();
    } catch (err) {
      nativeDb.prepare('ROLLBACK').run();
      throw err;
    }
  }, { migrationsFolder });
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
 * Re-export schema for external use.
 */
export { schema };
export type { SqliteRemoteDatabase };
