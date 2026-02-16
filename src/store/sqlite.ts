/**
 * SQLite store via drizzle-orm + sql.js (WASM).
 *
 * Zero native bindings, cross-platform. Database stored at .cleo/tasks.db.
 * Lazy initialization: WASM only loaded when first database operation occurs.
 * Journal mode (not WAL) since sql.js is in-memory WASM with explicit save.
 *
 * @epic T4454
 * @task W1-T1
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/sql-js';
import type { SQLJsDatabase } from 'drizzle-orm/sql-js';
import initSqlJs, { type Database as SqlJsNativeDb } from 'sql.js';
import * as schema from './schema.js';
import { getCleoDirAbsolute } from '../core/paths.js';

/** Database file name within .cleo/ directory. */
const DB_FILENAME = 'tasks.db';

/** Schema version stored in schema_meta table. */
const SCHEMA_VERSION = '1.0.0';

/** Singleton state for lazy initialization. */
let _db: SQLJsDatabase<typeof schema> | null = null;
let _nativeDb: SqlJsNativeDb | null = null;
let _dbPath: string | null = null;

/**
 * Get the path to the SQLite database file.
 */
export function getDbPath(cwd?: string): string {
  return join(getCleoDirAbsolute(cwd), DB_FILENAME);
}

/**
 * Initialize the SQLite database (lazy, singleton).
 * Creates the database file and tables if they don't exist.
 * Returns the drizzle ORM instance.
 */
export async function getDb(cwd?: string): Promise<SQLJsDatabase<typeof schema>> {
  if (_db) return _db;

  const dbPath = getDbPath(cwd);
  _dbPath = dbPath;

  // Initialize sql.js WASM
  const SQL = await initSqlJs();

  // Load existing database or create new
  let nativeDb: SqlJsNativeDb;
  if (existsSync(dbPath)) {
    const buffer = readFileSync(dbPath);
    nativeDb = new SQL.Database(buffer);
  } else {
    mkdirSync(dirname(dbPath), { recursive: true });
    nativeDb = new SQL.Database();
  }

  _nativeDb = nativeDb;

  // Create drizzle ORM wrapper
  const db = drizzle(nativeDb, { schema });
  _db = db;

  // Ensure tables exist
  await createTablesIfNeeded(nativeDb);

  return db;
}

/**
 * Create all tables if they don't exist.
 * Uses raw SQL since drizzle-kit migrations aren't needed for initial setup.
 */
async function createTablesIfNeeded(nativeDb: SqlJsNativeDb): Promise<void> {
  nativeDb.run(`
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

  nativeDb.run(`
    CREATE TABLE IF NOT EXISTS task_dependencies (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      depends_on TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, depends_on)
    );
  `);

  nativeDb.run(`
    CREATE TABLE IF NOT EXISTS task_relations (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      related_to TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      relation_type TEXT NOT NULL DEFAULT 'related'
        CHECK(relation_type IN ('related','blocks','duplicates')),
      PRIMARY KEY (task_id, related_to)
    );
  `);

  nativeDb.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active','ended','orphaned','suspended')),
      scope_json TEXT NOT NULL DEFAULT '{}',
      current_focus TEXT,
      focus_set_at TEXT,
      agent TEXT,
      notes_json TEXT DEFAULT '[]',
      tasks_completed_json TEXT DEFAULT '[]',
      tasks_created_json TEXT DEFAULT '[]',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT
    );
  `);

  nativeDb.run(`
    CREATE TABLE IF NOT EXISTS session_focus_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL,
      set_at TEXT NOT NULL DEFAULT (datetime('now')),
      cleared_at TEXT
    );
  `);

  nativeDb.run(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Create indexes (IF NOT EXISTS)
  nativeDb.run('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);');
  nativeDb.run('CREATE INDEX IF NOT EXISTS idx_tasks_parent_id ON tasks(parent_id);');
  nativeDb.run('CREATE INDEX IF NOT EXISTS idx_tasks_phase ON tasks(phase);');
  nativeDb.run('CREATE INDEX IF NOT EXISTS idx_tasks_type ON tasks(type);');
  nativeDb.run('CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);');
  nativeDb.run('CREATE INDEX IF NOT EXISTS idx_deps_depends_on ON task_dependencies(depends_on);');
  nativeDb.run('CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);');
  nativeDb.run('CREATE INDEX IF NOT EXISTS idx_focus_history_session ON session_focus_history(session_id);');

  // Set schema version
  nativeDb.run(
    `INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schemaVersion', '${SCHEMA_VERSION}')`,
  );

  // Save to disk
  saveToFile();
}

/**
 * Save the in-memory database to disk.
 * Must be called after any write operation since sql.js is in-memory.
 */
export function saveToFile(): void {
  if (!_nativeDb || !_dbPath) return;
  const data = _nativeDb.export();
  const buffer = Buffer.from(data);
  mkdirSync(dirname(_dbPath), { recursive: true });
  writeFileSync(_dbPath, buffer);
}

/**
 * Close the database connection and release resources.
 */
export function closeDb(): void {
  if (_nativeDb) {
    saveToFile();
    _nativeDb.close();
    _nativeDb = null;
  }
  _db = null;
  _dbPath = null;
}

/**
 * Get the schema version from the database.
 */
export async function getSchemaVersion(cwd?: string): Promise<string | null> {
  const db = await getDb(cwd);
  const result = db
    .select()
    .from(schema.schemaMeta)
    .where(eq(schema.schemaMeta.key, 'schemaVersion'))
    .all();

  return result[0]?.value ?? null;
}

/**
 * Check if the database file exists.
 */
export function dbExists(cwd?: string): boolean {
  return existsSync(getDbPath(cwd));
}

/**
 * Re-export schema for external use.
 */
export { schema };
export type { SQLJsDatabase };
