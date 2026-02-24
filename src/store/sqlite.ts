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
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import * as schema from './schema.js';
import { getCleoDirAbsolute } from '../core/paths.js';
import { openNativeDatabase, createDrizzleCallback, createBatchCallback } from './node-sqlite-adapter.js';

/** Database file name within .cleo/ directory. */
const DB_FILENAME = 'tasks.db';

/** Schema version for newly created databases. */
const SCHEMA_VERSION = '2.0.0';

/** Singleton state for lazy initialization. */
let _db: SqliteRemoteDatabase<typeof schema> | null = null;
let _nativeDb: DatabaseSync | null = null;
let _dbPath: string | null = null;
/** Track whether the DB was loaded from an existing file or created fresh. */
let _isNewDb = false;

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
 */
export async function getDb(cwd?: string): Promise<SqliteRemoteDatabase<typeof schema>> {
  const requestedPath = getDbPath(cwd);

  // If singleton exists but points to different path, reset it
  if (_db && _dbPath !== requestedPath) {
    resetDbState();
  }

  if (_db) return _db;

  const dbPath = requestedPath;
  _dbPath = dbPath;

  // Ensure directory exists
  mkdirSync(dirname(dbPath), { recursive: true });

  // Open file-backed SQLite via node:sqlite with WAL mode
  _isNewDb = !existsSync(dbPath);
  const nativeDb = openNativeDatabase(dbPath);
  _nativeDb = nativeDb;

  // Create drizzle ORM wrapper via sqlite-proxy
  const callback = createDrizzleCallback(nativeDb);
  const batchCb = createBatchCallback(nativeDb);
  const db = drizzle(callback, batchCb, { schema });
  _db = db;

  // Ensure tables exist
  createTablesIfNeeded(nativeDb);

  return db;
}

/**
 * Create all tables if they don't exist.
 * Uses raw SQL via node:sqlite DatabaseSync.exec() since drizzle-kit
 * migrations aren't needed for initial setup.
 *
 * With node:sqlite, writes go directly to disk via WAL -- no saveToFile() needed.
 *
 * @task T4810 - Only writes schema version for NEW databases.
 * Existing databases retain their schema version.
 */
export function createTablesIfNeeded(nativeDb: DatabaseSync): void {
  nativeDb.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','active','blocked','done','cancelled','archived')),
      priority TEXT NOT NULL DEFAULT 'medium'
        CHECK(priority IN ('critical','high','medium','low')),
      type TEXT CHECK(type IN ('epic','task','subtask')),
      parent_id TEXT REFERENCES tasks(id),
      phase TEXT,
      size TEXT CHECK(size IN ('small','medium','large')),
      position INTEGER,
      position_version INTEGER DEFAULT 0,
      labels_json TEXT DEFAULT '[]',
      notes_json TEXT DEFAULT '[]',
      acceptance_json TEXT DEFAULT '[]',
      files_json TEXT DEFAULT '[]',
      origin TEXT,
      blocked_by TEXT,
      epic_lifecycle TEXT,
      no_auto_complete INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT,
      completed_at TEXT,
      cancelled_at TEXT,
      cancellation_reason TEXT,
      archived_at TEXT,
      archive_reason TEXT,
      cycle_time_days INTEGER,
      verification_json TEXT,
      created_by TEXT,
      modified_by TEXT,
      session_id TEXT
    );
  `);

  nativeDb.exec(`
    CREATE TABLE IF NOT EXISTS task_dependencies (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      depends_on TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, depends_on)
    );
  `);

  nativeDb.exec(`
    CREATE TABLE IF NOT EXISTS task_relations (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      related_to TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      relation_type TEXT NOT NULL DEFAULT 'related'
        CHECK(relation_type IN ('related','blocks','duplicates')),
      PRIMARY KEY (task_id, related_to)
    );
  `);

  nativeDb.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active','ended','orphaned','suspended')),
      scope_json TEXT NOT NULL DEFAULT '{}',
      current_task TEXT,
      task_started_at TEXT,
      agent TEXT,
      notes_json TEXT DEFAULT '[]',
      tasks_completed_json TEXT DEFAULT '[]',
      tasks_created_json TEXT DEFAULT '[]',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT
    );
  `);

  nativeDb.exec(`
    CREATE TABLE IF NOT EXISTS task_work_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL,
      set_at TEXT NOT NULL DEFAULT (datetime('now')),
      cleared_at TEXT
    );
  `);

  nativeDb.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Create indexes (IF NOT EXISTS)
  nativeDb.exec('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);');
  nativeDb.exec('CREATE INDEX IF NOT EXISTS idx_tasks_parent_id ON tasks(parent_id);');
  nativeDb.exec('CREATE INDEX IF NOT EXISTS idx_tasks_phase ON tasks(phase);');
  nativeDb.exec('CREATE INDEX IF NOT EXISTS idx_tasks_type ON tasks(type);');
  nativeDb.exec('CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);');
  nativeDb.exec('CREATE INDEX IF NOT EXISTS idx_deps_depends_on ON task_dependencies(depends_on);');
  nativeDb.exec('CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);');
  nativeDb.exec('CREATE INDEX IF NOT EXISTS idx_work_history_session ON task_work_history(session_id);');

  // Only set schema version for NEW databases.
  // Existing databases already have their version and data.
  if (_isNewDb) {
    nativeDb.exec(
      `INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schemaVersion', '${SCHEMA_VERSION}')`,
    );
  }
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
  _isNewDb = false;
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
