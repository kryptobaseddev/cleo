/**
 * SQLite store for brain.db via drizzle-orm/sqlite-proxy + node:sqlite (DatabaseSync).
 *
 * Separate database from tasks.db for cognitive infrastructure (decisions,
 * patterns, learnings). Follows the same singleton + WAL + migration pattern
 * as sqlite.ts.
 *
 * @epic T5149
 * @task T5128
 */

import { mkdirSync } from 'node:fs';
// Type-only import for annotations. The runtime node:sqlite loading is handled
// by openNativeDatabase() in node-sqlite-adapter.ts via createRequire.
import type { DatabaseSync } from 'node:sqlite';

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { migrate } from 'drizzle-orm/sqlite-proxy/migrator';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import * as brainSchema from './brain-schema.js';
import { getCleoDirAbsolute } from '../core/paths.js';
import { openNativeDatabase, createDrizzleCallback, createBatchCallback } from './node-sqlite-adapter.js';

/** Database file name within .cleo/ directory. */
const DB_FILENAME = 'brain.db';

/** Schema version for newly created brain databases. Single source of truth. */
export const BRAIN_SCHEMA_VERSION = '1.0.0';

/** Singleton state for lazy initialization. */
let _db: SqliteRemoteDatabase<typeof brainSchema> | null = null;
let _nativeDb: DatabaseSync | null = null;
let _dbPath: string | null = null;
/** Guard against concurrent initialization (async migration). */
let _initPromise: Promise<SqliteRemoteDatabase<typeof brainSchema>> | null = null;

/**
 * Get the path to the brain.db SQLite database file.
 */
export function getBrainDbPath(cwd?: string): string {
  return join(getCleoDirAbsolute(cwd), DB_FILENAME);
}

/**
 * Resolve the path to the drizzle-brain migrations folder.
 * Works from both src/ (dev via tsx) and dist/ (compiled).
 */
export function resolveBrainMigrationsFolder(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // Both src/store/ and dist/store/ are 2 levels deep from package root
  return join(__dirname, '..', '..', 'drizzle-brain');
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
 * Run drizzle migrations to create/update brain.db tables.
 *
 * Uses IMMEDIATE transactions to prevent concurrent migration races.
 * Follows the same pattern as sqlite.ts runMigrations().
 *
 * @task T5128
 */
async function runBrainMigrations(
  nativeDb: DatabaseSync,
  db: SqliteRemoteDatabase<typeof brainSchema>,
): Promise<void> {
  const migrationsFolder = resolveBrainMigrationsFolder();

  // Bootstrap existing databases that predate drizzle migrations.
  // Mark baseline migration as already applied if tables exist but
  // __drizzle_migrations doesn't.
  if (tableExists(nativeDb, 'brain_decisions') && !tableExists(nativeDb, '__drizzle_migrations')) {
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
  // Each batch is wrapped in an IMMEDIATE transaction.
  await migrate(db, async (queries: string[]) => {
    nativeDb.prepare('BEGIN IMMEDIATE').run();
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
 * Initialize the brain.db SQLite database (lazy, singleton).
 * Creates the database file and tables if they don't exist.
 * Returns the drizzle ORM instance (async via sqlite-proxy).
 *
 * Uses a promise guard so concurrent callers wait for the same
 * initialization to complete (migrations are async).
 */
export async function getBrainDb(cwd?: string): Promise<SqliteRemoteDatabase<typeof brainSchema>> {
  const requestedPath = getBrainDbPath(cwd);

  // If singleton exists but points to different path, reset it
  if (_db && _dbPath !== requestedPath) {
    resetBrainDbState();
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
    const db = drizzle(callback, batchCb, { schema: brainSchema });

    // Run drizzle migrations (creates/updates tables)
    await runBrainMigrations(nativeDb, db);

    // Seed schema version for new databases (no-op if already set)
    nativeDb.exec(
      `INSERT OR IGNORE INTO brain_schema_meta (key, value) VALUES ('schemaVersion', '${BRAIN_SCHEMA_VERSION}')`,
    );

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
 * Close the brain.db database connection and release resources.
 */
export function closeBrainDb(): void {
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
 * Reset brain.db singleton state without saving.
 * Used during tests or when database file is recreated.
 * Safe to call multiple times.
 */
export function resetBrainDbState(): void {
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
 * Get the underlying node:sqlite DatabaseSync instance for brain.db.
 * Useful for direct PRAGMA calls or raw SQL operations.
 * Returns null if the database hasn't been initialized.
 */
export function getBrainNativeDb(): DatabaseSync | null {
  return _nativeDb;
}

/**
 * Re-export brain schema for external use.
 */
export { brainSchema };
export type { SqliteRemoteDatabase };
