/**
 * SQLite store for signaldock.db — local agent messaging database.
 *
 * Creates and manages .cleo/signaldock.db using node:sqlite directly.
 * Runs the consolidated Diesel migration SQL (from signaldock-storage crate)
 * to bootstrap all 22 tables for local agent infrastructure.
 *
 * This is the Node.js bootstrap path. In production cloud, the Rust
 * signaldock-storage crate manages this DB via Diesel ORM directly.
 * Locally, we create the DB here so that cleo init scaffolds the full
 * .cleo/ directory with all databases ready.
 *
 * @task T223
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { getCleoDirAbsolute } from '../paths.js';

const _require = createRequire(import.meta.url);
const { DatabaseSync: DatabaseSyncClass } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof DatabaseSync>) => DatabaseSync;
};

/** Database file name within .cleo/ directory. */
const DB_FILENAME = 'signaldock.db';

/** Schema version for signaldock databases. */
export const SIGNALDOCK_SCHEMA_VERSION = '2026.3.76';

/**
 * Get the path to the signaldock.db SQLite database file.
 */
export function getSignaldockDbPath(cwd?: string): string {
  const cleoDir = cwd ? join(cwd, '.cleo') : getCleoDirAbsolute();
  return join(cleoDir, DB_FILENAME);
}

/**
 * Resolve the migrations directory from the signaldock-storage crate.
 *
 * Contains Diesel migration subdirectories (e.g. 2026-03-28-000000_initial/).
 * Each subdirectory has an up.sql file.
 */
function resolveMigrationsDir(cwd?: string): string | null {
  const projectRoot = cwd ?? process.cwd();
  const monorepoPath = join(projectRoot, 'crates', 'signaldock-storage', 'migrations');
  if (existsSync(monorepoPath)) return monorepoPath;

  const thisDir = dirname(fileURLToPath(import.meta.url));
  const installedPath = join(
    thisDir,
    '..',
    '..',
    '..',
    '..',
    'crates',
    'signaldock-storage',
    'migrations',
  );
  if (existsSync(installedPath)) return installedPath;

  return null;
}

/**
 * Get all migration directories sorted by name (chronological order).
 *
 * Returns paths to up.sql files for each migration.
 */
function getMigrationFiles(migrationsDir: string): string[] {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .map((name) => join(migrationsDir, name, 'up.sql'))
    .filter((p) => existsSync(p));
}

/**
 * Ensure signaldock.db exists and has the full schema applied.
 *
 * Idempotent — safe to call multiple times. Uses `CREATE TABLE IF NOT EXISTS`
 * and `CREATE INDEX IF NOT EXISTS` throughout.
 *
 * @returns Object with action ('created' | 'exists') and the database path.
 */
export async function ensureSignaldockDb(
  cwd?: string,
): Promise<{ action: 'created' | 'exists'; path: string }> {
  const dbPath = getSignaldockDbPath(cwd);
  const alreadyExists = existsSync(dbPath);

  // Ensure parent directory exists
  mkdirSync(dirname(dbPath), { recursive: true });

  // Open or create the database
  const db = new DatabaseSyncClass(dbPath);

  try {
    // Set pragmas for optimal performance
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA cache_size = -64000'); // 64MB

    // Check if schema already applied (agents table as sentinel)
    const hasSchema = (() => {
      try {
        const result = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agents'")
          .get() as { name: string } | undefined;
        return !!result;
      } catch {
        return false;
      }
    })();

    // Ensure migration tracking tables exist
    db.exec(`
      CREATE TABLE IF NOT EXISTS _signaldock_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS _signaldock_migrations (
        name TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
      )
    `);

    // Discover and apply migrations
    const migrationsDir = resolveMigrationsDir(cwd);
    if (!migrationsDir) {
      throw new Error(
        'signaldock-storage migrations directory not found. Ensure crates/signaldock-storage/ exists.',
      );
    }

    const migrationFiles = getMigrationFiles(migrationsDir);
    for (const sqlPath of migrationFiles) {
      const migrationName = sqlPath.split('/').slice(-2, -1)[0] ?? sqlPath;

      // Skip already-applied migrations
      const applied = db
        .prepare('SELECT name FROM _signaldock_migrations WHERE name = ?')
        .get(migrationName) as { name: string } | undefined;
      if (applied) continue;

      const migrationSql = readFileSync(sqlPath, 'utf-8');
      db.exec('BEGIN TRANSACTION');
      try {
        db.exec(migrationSql);
        db.prepare('INSERT INTO _signaldock_migrations (name) VALUES (?)').run(migrationName);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }

    // Record schema version
    db.exec(`
      INSERT OR REPLACE INTO _signaldock_meta (key, value, updated_at)
      VALUES ('schema_version', '${SIGNALDOCK_SCHEMA_VERSION}', strftime('%s', 'now'))
    `);

    return {
      action: alreadyExists && hasSchema ? 'exists' : 'created',
      path: dbPath,
    };
  } finally {
    db.close();
  }
}

/**
 * Check signaldock.db health — table count, WAL mode, schema version.
 *
 * Used by `cleo doctor` to verify signaldock.db integrity.
 *
 * @returns Health report object or null if DB doesn't exist.
 */
export async function checkSignaldockDbHealth(cwd?: string): Promise<{
  exists: boolean;
  path: string;
  tableCount: number;
  walMode: boolean;
  schemaVersion: string | null;
  foreignKeysEnabled: boolean;
} | null> {
  const dbPath = getSignaldockDbPath(cwd);
  if (!existsSync(dbPath)) {
    return {
      exists: false,
      path: dbPath,
      tableCount: 0,
      walMode: false,
      schemaVersion: null,
      foreignKeysEnabled: false,
    };
  }

  const db = new DatabaseSyncClass(dbPath);
  try {
    const tables = db
      .prepare(
        "SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .get() as { count: number };

    const journalMode = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    const fkEnabled = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };

    let schemaVersion: string | null = null;
    try {
      const meta = db
        .prepare("SELECT value FROM _signaldock_meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined;
      schemaVersion = meta?.value ?? null;
    } catch {
      // Meta table may not exist
    }

    return {
      exists: true,
      path: dbPath,
      tableCount: tables.count,
      walMode: journalMode.journal_mode === 'wal',
      schemaVersion,
      foreignKeysEnabled: fkEnabled.foreign_keys === 1,
    };
  } finally {
    db.close();
  }
}
