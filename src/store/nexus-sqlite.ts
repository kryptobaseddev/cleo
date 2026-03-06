/**
 * SQLite store for nexus.db via drizzle-orm/sqlite-proxy + node:sqlite (DatabaseSync).
 *
 * Separate database from tasks.db and brain.db for cross-project registry
 * and audit infrastructure. Follows the same singleton + WAL + migration
 * pattern as brain-sqlite.ts.
 *
 * nexus.db lives in ~/.cleo/ (global home) rather than per-project .cleo/,
 * since it stores cross-project data.
 *
 * @task T5365
 */

import { mkdirSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { migrate } from 'drizzle-orm/sqlite-proxy/migrator';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import * as nexusSchema from './nexus-schema.js';
import { getCleoHome } from '../core/paths.js';
import { openNativeDatabase, createDrizzleCallback, createBatchCallback } from './node-sqlite-adapter.js';

/** Database file name within ~/.cleo/ directory. */
const DB_FILENAME = 'nexus.db';

/** Schema version for newly created nexus databases. Single source of truth. */
export const NEXUS_SCHEMA_VERSION = '1.0.0';

/** Singleton state for lazy initialization. */
let _nexusDb: SqliteRemoteDatabase<typeof nexusSchema> | null = null;
let _nexusNativeDb: DatabaseSync | null = null;
let _nexusDbPath: string | null = null;
/** Guard against concurrent initialization (async migration). */
let _nexusInitPromise: Promise<SqliteRemoteDatabase<typeof nexusSchema>> | null = null;

/**
 * Get the path to the nexus.db SQLite database file.
 * nexus.db lives in the global ~/.cleo/ directory.
 */
export function getNexusDbPath(): string {
  return join(getCleoHome(), DB_FILENAME);
}

/**
 * Resolve the path to the drizzle-nexus migrations folder.
 * Works from both src/ (dev via tsx) and dist/ (compiled).
 */
export function resolveNexusMigrationsFolder(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // Both src/store/ and dist/store/ are 2 levels deep from package root
  return join(__dirname, '..', '..', 'drizzle-nexus');
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
 * Run drizzle migrations to create/update nexus.db tables.
 *
 * Uses IMMEDIATE transactions to prevent concurrent migration races.
 * Follows the same pattern as brain-sqlite.ts runBrainMigrations().
 *
 * @task T5365
 */
async function runNexusMigrations(
  nativeDb: DatabaseSync,
  db: SqliteRemoteDatabase<typeof nexusSchema>,
): Promise<void> {
  const migrationsFolder = resolveNexusMigrationsFolder();

  // Bootstrap existing databases that predate drizzle migrations.
  // Mark baseline migration as already applied if tables exist but
  // __drizzle_migrations doesn't.
  if (tableExists(nativeDb, 'project_registry') && !tableExists(nativeDb, '__drizzle_migrations')) {
    const migrations = readMigrationFiles({ migrationsFolder });
    const baseline = migrations[0];
    if (baseline) {
      nativeDb.prepare(
        `CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`,
      ).run();
      nativeDb.prepare(
        `INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES ('${baseline.hash}', ${baseline.folderMillis})`,
      ).run();
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
 * Initialize the nexus.db SQLite database (lazy, singleton).
 * Creates the database file and tables if they don't exist.
 * Returns the drizzle ORM instance (async via sqlite-proxy).
 *
 * Uses a promise guard so concurrent callers wait for the same
 * initialization to complete (migrations are async).
 */
export async function getNexusDb(): Promise<SqliteRemoteDatabase<typeof nexusSchema>> {
  const requestedPath = getNexusDbPath();

  // If singleton exists but points to different path, reset it
  if (_nexusDb && _nexusDbPath !== requestedPath) {
    resetNexusDbState();
  }

  if (_nexusDb) return _nexusDb;

  // If already initializing, wait for the in-flight init
  if (_nexusInitPromise) return _nexusInitPromise;

  _nexusInitPromise = (async () => {
    const dbPath = requestedPath;
    _nexusDbPath = dbPath;

    // Ensure directory exists
    mkdirSync(dirname(dbPath), { recursive: true });

    // Open file-backed SQLite via node:sqlite with WAL mode.
    const nativeDb = openNativeDatabase(dbPath);
    _nexusNativeDb = nativeDb;

    // Create drizzle ORM wrapper via sqlite-proxy
    const callback = createDrizzleCallback(nativeDb);
    const batchCb = createBatchCallback(nativeDb);
    const db = drizzle(callback, batchCb, { schema: nexusSchema });

    // Run drizzle migrations (creates/updates tables)
    await runNexusMigrations(nativeDb, db);

    // Seed schema version for new databases (no-op if already set)
    nativeDb.prepare(
      `INSERT OR IGNORE INTO nexus_schema_meta (key, value) VALUES ('schemaVersion', '${NEXUS_SCHEMA_VERSION}')`,
    ).run();

    // Set singleton only after migrations complete
    _nexusDb = db;
    return db;
  })();

  try {
    return await _nexusInitPromise;
  } finally {
    _nexusInitPromise = null;
  }
}

/**
 * Close the nexus.db database connection and release resources.
 */
export function closeNexusDb(): void {
  if (_nexusNativeDb) {
    try {
      if (_nexusNativeDb.isOpen) {
        _nexusNativeDb.close();
      }
    } catch {
      // Ignore close errors
    }
    _nexusNativeDb = null;
  }
  _nexusDb = null;
  _nexusDbPath = null;
}

/**
 * Reset nexus.db singleton state without saving.
 * Used during tests or when database file is recreated.
 * Safe to call multiple times.
 */
export function resetNexusDbState(): void {
  if (_nexusNativeDb) {
    try {
      if (_nexusNativeDb.isOpen) {
        _nexusNativeDb.close();
      }
    } catch {
      // Ignore close errors
    }
    _nexusNativeDb = null;
  }
  _nexusDb = null;
  _nexusDbPath = null;
  _nexusInitPromise = null;
}

/**
 * Get the underlying node:sqlite DatabaseSync instance for nexus.db.
 * Useful for direct PRAGMA calls or raw SQL operations.
 * Returns null if the database hasn't been initialized.
 */
export function getNexusNativeDb(): DatabaseSync | null {
  return _nexusNativeDb;
}

/**
 * Re-export nexus schema for external use.
 */
export { nexusSchema };
export type { SqliteRemoteDatabase };
