/**
 * SQLite store for telemetry.db via drizzle-orm/node-sqlite + node:sqlite.
 *
 * Stores opt-in command telemetry in ~/.local/share/cleo/telemetry.db.
 * Follows the same singleton + WAL + migration pattern as brain-sqlite.ts.
 * Telemetry is disabled by default — check isTelemetryEnabled() before writing.
 *
 * @task T624
 */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { getCleoHome } from '../paths.js';
import { ensureColumns, migrateWithRetry, reconcileJournal } from '../store/migration-manager.js';
import { openNativeDatabase } from '../store/sqlite.js';
import * as telemetrySchema from './schema.js';

/** Database file name in the global CLEO home directory. */
const DB_FILENAME = 'telemetry.db';

/** Schema version. Single source of truth. */
export const TELEMETRY_SCHEMA_VERSION = '1.0.0';

/** Singleton state. */
let _db: NodeSQLiteDatabase<typeof telemetrySchema> | null = null;
let _nativeDb: DatabaseSync | null = null;
let _dbPath: string | null = null;
let _initPromise: Promise<NodeSQLiteDatabase<typeof telemetrySchema>> | null = null;

/**
 * Get the absolute path to telemetry.db in the global CLEO home directory.
 * Linux: ~/.local/share/cleo/telemetry.db
 */
export function getTelemetryDbPath(): string {
  return join(getCleoHome(), DB_FILENAME);
}

/**
 * Resolve the drizzle-telemetry migrations folder.
 * Handles both src/ (dev via tsx) and dist/ (bundled) layouts.
 */
export function resolveTelemetryMigrationsFolder(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dir = dirname(__filename);
  // src/telemetry/ → ../../migrations/drizzle-telemetry
  // dist/          → ../migrations/drizzle-telemetry
  const isBundled = __dir.endsWith('/dist') || __dir.endsWith('\\dist');
  const pkgRoot = isBundled ? join(__dir, '..') : join(__dir, '..', '..');
  return join(pkgRoot, 'migrations', 'drizzle-telemetry');
}

/**
 * Run drizzle migrations to create/update telemetry.db tables.
 */
function runTelemetryMigrations(
  nativeDb: DatabaseSync,
  db: NodeSQLiteDatabase<typeof telemetrySchema>,
): void {
  const migrationsFolder = resolveTelemetryMigrationsFolder();

  reconcileJournal(nativeDb, migrationsFolder, 'telemetry_events', 'telemetry');
  migrateWithRetry(db, migrationsFolder, nativeDb, 'telemetry_events', 'telemetry');

  // Safety net: ensure core columns exist even if migration was skipped.
  ensureColumns(
    nativeDb,
    'telemetry_events',
    [
      { name: 'anonymous_id', ddl: "text NOT NULL DEFAULT ''" },
      { name: 'domain', ddl: "text NOT NULL DEFAULT ''" },
      { name: 'gateway', ddl: "text NOT NULL DEFAULT 'query'" },
      { name: 'operation', ddl: "text NOT NULL DEFAULT ''" },
      { name: 'command', ddl: "text NOT NULL DEFAULT ''" },
      { name: 'exit_code', ddl: 'integer NOT NULL DEFAULT 0' },
      { name: 'duration_ms', ddl: 'integer NOT NULL DEFAULT 0' },
      { name: 'error_code', ddl: 'text' },
    ],
    'telemetry',
  );
}

/**
 * Reset the singleton (used in tests).
 */
export function resetTelemetryDbState(): void {
  try {
    _nativeDb?.close();
  } catch {
    // ignore
  }
  _db = null;
  _nativeDb = null;
  _dbPath = null;
  _initPromise = null;
}

/**
 * Initialize telemetry.db (lazy singleton).
 * Creates the file and runs migrations on first call.
 */
export async function getTelemetryDb(): Promise<NodeSQLiteDatabase<typeof telemetrySchema>> {
  const requestedPath = getTelemetryDbPath();

  if (_db && _dbPath !== requestedPath) {
    resetTelemetryDbState();
  }

  if (_db) return _db;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const dbPath = requestedPath;
    _dbPath = dbPath;

    mkdirSync(dirname(dbPath), { recursive: true });

    const nativeDb = openNativeDatabase(dbPath);
    _nativeDb = nativeDb;

    const db = drizzle({ client: nativeDb, schema: telemetrySchema });

    runTelemetryMigrations(nativeDb, db);

    // Seed schema version (idempotent)
    nativeDb
      .prepare(
        `INSERT OR IGNORE INTO telemetry_schema_meta (key, value) VALUES ('schemaVersion', '${TELEMETRY_SCHEMA_VERSION}')`,
      )
      .run();

    _db = db;
    return db;
  })();

  return _initPromise;
}
