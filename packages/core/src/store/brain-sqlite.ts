/**
 * SQLite store for brain.db via drizzle-orm/node-sqlite + node:sqlite (DatabaseSync).
 *
 * Separate database from tasks.db for cognitive infrastructure (decisions,
 * patterns, learnings). Follows the same singleton + WAL + migration pattern
 * as sqlite.ts.
 *
 * @epic T5149
 * @task T5128
 */

import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
// Type-only import for annotations. The runtime node:sqlite loading is handled
// by openNativeDatabase() in sqlite.ts.
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { getCleoDirAbsolute } from '../paths.js';
import * as brainSchema from './brain-schema.js';
import {
  createSafetyBackup,
  ensureColumns,
  migrateWithRetry,
  reconcileJournal,
  tableExists,
} from './migration-manager.js';
import { openNativeDatabase } from './sqlite.js';

const _require = createRequire(import.meta.url);

/** Database file name within .cleo/ directory. */
const DB_FILENAME = 'brain.db';

/** Schema version for newly created brain databases. Single source of truth. */
export const BRAIN_SCHEMA_VERSION = '1.0.0';

/** Singleton state for lazy initialization. */
let _db: NodeSQLiteDatabase<typeof brainSchema> | null = null;
let _nativeDb: DatabaseSync | null = null;
let _dbPath: string | null = null;
/** Guard against concurrent initialization (async migration). */
let _initPromise: Promise<NodeSQLiteDatabase<typeof brainSchema>> | null = null;
/** Whether sqlite-vec extension loaded successfully. */
let _vecLoaded = false;

/**
 * Get the path to the brain.db SQLite database file.
 */
export function getBrainDbPath(cwd?: string): string {
  return join(getCleoDirAbsolute(cwd), DB_FILENAME);
}

/**
 * Resolve the path to the drizzle-brain migrations folder.
 * Works from both src/ (dev via tsx) and dist/ (compiled via esbuild bundle).
 *
 * - Source layout: __dirname = src/store/ → need ../../migrations/drizzle-brain
 * - Bundled layout: __dirname = dist/     → need ../migrations/drizzle-brain
 */
export function resolveBrainMigrationsFolder(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const isBundled = __dirname.endsWith('/dist') || __dirname.endsWith('\\dist');
  const pkgRoot = isBundled ? join(__dirname, '..') : join(__dirname, '..', '..');
  return join(pkgRoot, 'migrations', 'drizzle-brain');
}

// tableExists — delegated to migration-manager.ts (T132)

/**
 * Run drizzle migrations to create/update brain.db tables.
 *
 * Delegates to shared migration-manager.ts for journal reconciliation,
 * retry logic, and safety backups. See T132 for consolidation rationale.
 *
 * @task T5128
 * @task T132 - Unified migration system
 */
function runBrainMigrations(
  nativeDb: DatabaseSync,
  db: NodeSQLiteDatabase<typeof brainSchema>,
): void {
  const migrationsFolder = resolveBrainMigrationsFolder();

  // Safety backup before any migration work
  if (tableExists(nativeDb, 'brain_decisions') && _dbPath) {
    createSafetyBackup(_dbPath);
  }

  // Bootstrap baseline + reconcile stale journal entries
  reconcileJournal(nativeDb, migrationsFolder, 'brain_decisions', 'brain');

  // Run pending migrations with SQLITE_BUSY retry.
  // Pass nativeDb + existenceTable so migrateWithRetry can auto-reconcile any
  // partial migration (Scenario 3) that slips through the proactive check above.
  migrateWithRetry(db, migrationsFolder, nativeDb, 'brain_decisions', 'brain');

  // Safety net: ensure all columns from T528/T531/T549 exist even if the
  // migration files were never committed to git or the journal was not updated.
  // ensureColumns uses PRAGMA table_info + ALTER TABLE ADD COLUMN — idempotent.

  // T528: graph schema expansion — quality scoring, content hashing, last-activity.
  // Note: last_activity_at uses nullable text (no non-constant default) because
  // ALTER TABLE ADD COLUMN with datetime('now') default fails on non-empty tables.
  ensureColumns(
    nativeDb,
    'brain_page_nodes',
    [
      { name: 'quality_score', ddl: 'real DEFAULT 0.5' },
      { name: 'content_hash', ddl: 'text' },
      { name: 'last_activity_at', ddl: 'text' },
      { name: 'updated_at', ddl: 'text' },
    ],
    'brain',
  );

  // T531: quality score on typed brain tables
  for (const table of [
    'brain_decisions',
    'brain_patterns',
    'brain_learnings',
    'brain_observations',
  ] as const) {
    ensureColumns(nativeDb, table, [{ name: 'quality_score', ddl: 'real' }], 'brain');
  }

  // T549: tiered + typed memory architecture
  for (const table of [
    'brain_decisions',
    'brain_patterns',
    'brain_learnings',
    'brain_observations',
  ] as const) {
    ensureColumns(
      nativeDb,
      table,
      [
        { name: 'memory_tier', ddl: "text DEFAULT 'short'" },
        { name: 'memory_type', ddl: "text DEFAULT 'episodic'" },
        { name: 'verified', ddl: 'integer NOT NULL DEFAULT 0' },
        // valid_at uses nullable text (no datetime('now') default) because
        // ALTER TABLE ADD COLUMN with non-constant defaults fails on non-empty tables.
        { name: 'valid_at', ddl: 'text' },
        { name: 'invalid_at', ddl: 'text' },
        { name: 'source_confidence', ddl: "text DEFAULT 'agent'" },
        { name: 'citation_count', ddl: 'integer NOT NULL DEFAULT 0' },
      ],
      'brain',
    );
  }

  // T417: agent provenance field on brain_observations.
  // Added here as a safety net because the T417 migration file is an ALTER TABLE
  // that is skipped on fresh databases when the migration journal reconciler marks
  // all migrations as applied without actually running them (Scenario 2 race).
  // ensureColumns is idempotent — no-op if the column already exists.
  ensureColumns(nativeDb, 'brain_observations', [{ name: 'agent', ddl: 'text' }], 'brain');
}

/**
 * Load the sqlite-vec extension into a native DatabaseSync instance.
 * Returns true if the extension loaded successfully, false otherwise.
 *
 * The extension enables vec0 virtual tables for vector similarity search.
 * Requires the database to be opened with allowExtension: true.
 *
 * @task T5157
 */
function loadBrainVecExtension(nativeDb: DatabaseSync): boolean {
  try {
    const sqliteVec = _require('sqlite-vec') as { load: (db: DatabaseSync) => void };
    sqliteVec.load(nativeDb);
    return true;
  } catch {
    // sqlite-vec not available or failed to load — non-fatal
    return false;
  }
}

/**
 * Create the vec0 virtual table for brain embeddings.
 * Called after migrations complete and sqlite-vec extension is loaded.
 *
 * The vec0 table is not managed by Drizzle (virtual tables are not
 * supported by drizzle-orm's SQLite schema). Created via raw SQL.
 *
 * @task T5157
 */
function initializeBrainVec(nativeDb: DatabaseSync): void {
  nativeDb
    .prepare(
      'CREATE VIRTUAL TABLE IF NOT EXISTS brain_embeddings USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[384])',
    )
    .run();
}

/**
 * Check whether the sqlite-vec extension is loaded for the current brain.db.
 */
export function isBrainVecLoaded(): boolean {
  return _vecLoaded;
}

/**
 * Initialize the default embedding provider when brain.embedding.enabled is true.
 *
 * Called asynchronously after getBrainDb() completes its synchronous setup.
 * Uses dynamic import to avoid circular dependencies and keep the heavy
 * @huggingface/transformers bundle out of the critical startup path.
 *
 * Best-effort: errors are swallowed by the caller so DB access is never blocked.
 *
 * @task T539
 */
async function initEmbeddingProvider(cwd?: string): Promise<void> {
  try {
    const { loadConfig } = await import('../config.js');
    const config = await loadConfig(cwd);
    if (config.brain?.embedding?.enabled) {
      const { initDefaultProvider } = await import('../memory/brain-embedding.js');
      await initDefaultProvider();
    }
  } catch {
    // Config load or provider init failed — non-fatal, embedding stays unavailable
  }
}

/**
 * Initialize the brain.db SQLite database (lazy, singleton).
 * Creates the database file and tables if they don't exist.
 * Returns the drizzle ORM instance (async via sqlite-proxy).
 *
 * Uses a promise guard so concurrent callers wait for the same
 * initialization to complete (migrations are async).
 */
export async function getBrainDb(cwd?: string): Promise<NodeSQLiteDatabase<typeof brainSchema>> {
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

    // Open file-backed SQLite via node:sqlite with WAL mode.
    // allowExtension: true enables sqlite-vec extension loading.
    const nativeDb = openNativeDatabase(dbPath, { allowExtension: true });
    _nativeDb = nativeDb;

    // Load sqlite-vec extension for vector similarity search (T5157).
    // Non-fatal if unavailable — vec0 tables simply won't be created.
    _vecLoaded = loadBrainVecExtension(nativeDb);

    // Create drizzle ORM wrapper via node-sqlite
    const db = drizzle({ client: nativeDb, schema: brainSchema });

    // Run drizzle migrations (creates/updates tables)
    runBrainMigrations(nativeDb, db);

    // Create vec0 virtual table for embeddings if extension is loaded (T5157).
    // Must run after migrations so the schema is consistent.
    if (_vecLoaded) {
      initializeBrainVec(nativeDb);
    }

    // Seed schema version for new databases (no-op if already set)
    nativeDb
      .prepare(
        `INSERT OR IGNORE INTO brain_schema_meta (key, value) VALUES ('schemaVersion', '${BRAIN_SCHEMA_VERSION}')`,
      )
      .run();

    // Set singleton only after migrations complete
    _db = db;

    // Wire the default embedding provider when vec is loaded and embedding is enabled.
    // Best-effort, async, never blocks DB access. (T539)
    if (_vecLoaded) {
      setImmediate(() => {
        initEmbeddingProvider(cwd).catch(() => {
          // Non-fatal — embedding will be unavailable until next startup
        });
      });
    }

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
  _vecLoaded = false;
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
  _vecLoaded = false;
}

/**
 * Get the underlying node:sqlite DatabaseSync instance for brain.db.
 * Useful for direct PRAGMA calls or raw SQL operations.
 * Returns null if the database hasn't been initialized.
 */
export function getBrainNativeDb(): DatabaseSync | null {
  return _nativeDb;
}

export type { NodeSQLiteDatabase };
/**
 * Re-export brain schema for external use.
 */
export { brainSchema };
