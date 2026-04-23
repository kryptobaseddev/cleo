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
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { getCleoDirAbsolute } from '../paths.js';
import * as brainSchema from './memory-schema.js';
import {
  createSafetyBackup,
  ensureColumns,
  migrateWithRetry,
  reconcileJournal,
  tableExists,
} from './migration-manager.js';
import { resolveCorePackageMigrationsFolder } from './resolve-migrations-folder.js';
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
 * Resolve the absolute path to the drizzle-brain migrations folder inside
 * @cleocode/core, using ESM-native module resolution (T1177).
 *
 * Delegates to {@link resolveCorePackageMigrationsFolder} which handles
 * bundled dist/, workspace dev, and global-install layouts uniformly via
 * `import.meta.resolve()` + `createRequire().resolve()` fallback.
 */
export function resolveBrainMigrationsFolder(): string {
  return resolveCorePackageMigrationsFolder('drizzle-brain');
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

  // T632 root-cause fix (complete): the migration journal reconciler (Sub-case B)
  // uses a per-migration DDL probe (probeAndMarkApplied in migration-manager.ts)
  // instead of wholesale-marking-all-applied. ALTER TABLE ADD COLUMN migrations
  // (T417 agent, T528 graph schema, T531 quality-score, T549 tiered-memory, etc.)
  // now run correctly when their columns are missing — the reconciler leaves them
  // unjournaled so Drizzle's migrate() runs the DDL.
  //
  // The ensureColumns band-aids for T528/T531/T549 were removed here as part of
  // T632 because all their columns are covered by Drizzle migration files. If a
  // schema regression recurs, debug probeAndMarkApplied in migration-manager.ts —
  // do NOT add new band-aids here.
  //
  // ensureColumns below are retained ONLY for columns that have NO corresponding
  // Drizzle migration file (self-healing DDL only — see each comment).

  // T626-M1: Normalize co_retrieved edge type — idempotent safety-net UPDATE.
  // The shipped Hebbian strengthener emitted edge_type = 'relates_to' instead of
  // 'co_retrieved'. Relabel only rows from the consolidation provenance so no
  // semantic edges are affected. The Drizzle migration file does the same UPDATE;
  // this guard handles installs where the journal reconciler already marked
  // the migration applied before the SQL ran.
  //
  // T759: Guard provenance column existence before UPDATE. If T528 migration has
  // not yet run (e.g. on a fresh install where only the initial migration is
  // present), brain_page_edges will not have a provenance column and the UPDATE
  // will throw "no such column: provenance". ensureColumns adds the column if
  // missing so the UPDATE is always safe to execute.
  if (tableExists(nativeDb, 'brain_page_edges')) {
    ensureColumns(nativeDb, 'brain_page_edges', [{ name: 'provenance', ddl: 'text' }], 'brain');
    nativeDb
      .prepare(
        `UPDATE brain_page_edges
         SET edge_type = 'co_retrieved'
         WHERE edge_type = 'relates_to'
           AND provenance LIKE 'consolidation:%'`,
      )
      .run();
  }

  // T673-M1: STDP plasticity columns on brain_retrieval_log.
  // session_id was declared in the Drizzle schema but never applied to the live table.
  // reward_signal, retrieval_order, delta_ms are new additions per spec §2.1.1.
  if (tableExists(nativeDb, 'brain_retrieval_log')) {
    ensureColumns(
      nativeDb,
      'brain_retrieval_log',
      [
        { name: 'session_id', ddl: 'text' },
        { name: 'reward_signal', ddl: 'real' },
        { name: 'retrieval_order', ddl: 'integer' },
        { name: 'delta_ms', ddl: 'integer' },
      ],
      'brain',
    );
  }

  // T673-M2: observability columns on brain_plasticity_events
  // session_id is declared in Drizzle schema and included in M2 CREATE TABLE IF NOT EXISTS,
  // but may be missing from installs where the table was created before M2.
  if (tableExists(nativeDb, 'brain_plasticity_events')) {
    ensureColumns(
      nativeDb,
      'brain_plasticity_events',
      [
        { name: 'session_id', ddl: 'text' },
        { name: 'weight_before', ddl: 'real' },
        { name: 'weight_after', ddl: 'real' },
        { name: 'retrieval_log_id', ddl: 'integer' },
        { name: 'reward_signal', ddl: 'real' },
        { name: 'delta_t_ms', ddl: 'integer' },
      ],
      'brain',
    );
  }

  // T673-M3: plasticity tracking columns on brain_page_edges
  ensureColumns(
    nativeDb,
    'brain_page_edges',
    [
      { name: 'last_reinforced_at', ddl: 'text' },
      { name: 'reinforcement_count', ddl: 'integer NOT NULL DEFAULT 0' },
      { name: 'plasticity_class', ddl: "text NOT NULL DEFAULT 'static'" },
      { name: 'last_depressed_at', ddl: 'text' },
      { name: 'depression_count', ddl: 'integer NOT NULL DEFAULT 0' },
      { name: 'stability_score', ddl: 'real' },
    ],
    'brain',
  );

  // T673-M3: seed co_retrieved edges as hebbian (idempotent)
  if (tableExists(nativeDb, 'brain_page_edges')) {
    nativeDb
      .prepare(
        `UPDATE brain_page_edges SET plasticity_class = 'hebbian'
         WHERE edge_type = 'co_retrieved' AND plasticity_class = 'static'`,
      )
      .run();
  }

  // T673-M4: new plasticity infrastructure tables — self-healing CREATE IF NOT EXISTS.
  // These guards ensure the tables exist even on installs where the Drizzle migration
  // journal was already partially applied. All three tables are CREATE IF NOT EXISTS
  // so re-running is safe.
  nativeDb.exec(
    `CREATE TABLE IF NOT EXISTS brain_weight_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      edge_from_id TEXT NOT NULL,
      edge_to_id TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      weight_before REAL,
      weight_after REAL NOT NULL,
      delta_weight REAL NOT NULL,
      event_kind TEXT NOT NULL,
      source_plasticity_event_id INTEGER,
      retrieval_log_id INTEGER,
      reward_signal REAL,
      changed_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  );
  nativeDb.exec(
    `CREATE INDEX IF NOT EXISTS idx_weight_history_edge
      ON brain_weight_history (edge_from_id, edge_to_id, edge_type)`,
  );
  nativeDb.exec(
    `CREATE INDEX IF NOT EXISTS idx_weight_history_changed_at
      ON brain_weight_history (changed_at)`,
  );

  nativeDb.exec(
    `CREATE TABLE IF NOT EXISTS brain_modulators (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      modulator_type TEXT NOT NULL,
      valence REAL NOT NULL,
      magnitude REAL NOT NULL DEFAULT 1.0,
      source_event_id TEXT,
      session_id TEXT,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  );
  nativeDb.exec(
    `CREATE INDEX IF NOT EXISTS idx_modulators_session
      ON brain_modulators (session_id)`,
  );

  nativeDb.exec(
    `CREATE TABLE IF NOT EXISTS brain_consolidation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger TEXT NOT NULL,
      session_id TEXT,
      step_results_json TEXT NOT NULL,
      duration_ms INTEGER,
      succeeded INTEGER NOT NULL DEFAULT 1,
      started_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  );
  nativeDb.exec(
    `CREATE INDEX IF NOT EXISTS idx_consolidation_events_started_at
      ON brain_consolidation_events (started_at)`,
  );

  // T1002: brain_transcript_events — full-fidelity Claude session block store.
  // CREATE IF NOT EXISTS so re-runs on existing databases are safe.
  nativeDb.exec(
    `CREATE TABLE IF NOT EXISTS brain_transcript_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      block_type TEXT NOT NULL,
      content TEXT NOT NULL,
      tokens INTEGER,
      redacted_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  );
  nativeDb.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_transcript_events_session_seq
      ON brain_transcript_events (session_id, seq)`,
  );
  nativeDb.exec(
    `CREATE INDEX IF NOT EXISTS idx_transcript_events_session
      ON brain_transcript_events (session_id)`,
  );
  nativeDb.exec(
    `CREATE INDEX IF NOT EXISTS idx_transcript_events_role
      ON brain_transcript_events (role)`,
  );
  nativeDb.exec(
    `CREATE INDEX IF NOT EXISTS idx_transcript_events_block_type
      ON brain_transcript_events (block_type)`,
  );

  // T1001: stability_score column on brain_observations (distinct from brain_page_edges.stability_score).
  // Added via ensureColumns — idempotent, safe on existing databases.
  ensureColumns(
    nativeDb,
    'brain_observations',
    [{ name: 'stability_score', ddl: 'real DEFAULT 0.5' }],
    'brain',
  );

  // T1084: PSYCHE Wave 2 — peer_id + peer_scope on all four brain memory tables.
  // Drizzle migration 20260423000001_t1084-peer-id-memory-isolation handles fresh installs.
  // ensureColumns here is the safety-net for installs where the migration journal was
  // already partially applied or the journal reconciler skips DDL-only migrations.
  // Both columns are NOT NULL with a DEFAULT so the ALTER is safe on non-empty tables.
  const peerColumns = [
    { name: 'peer_id', ddl: "text NOT NULL DEFAULT 'global'" },
    { name: 'peer_scope', ddl: "text NOT NULL DEFAULT 'project'" },
  ];
  ensureColumns(nativeDb, 'brain_decisions', peerColumns, 'brain');
  ensureColumns(nativeDb, 'brain_patterns', peerColumns, 'brain');
  ensureColumns(nativeDb, 'brain_learnings', peerColumns, 'brain');
  ensureColumns(nativeDb, 'brain_observations', peerColumns, 'brain');
  // Companion indexes — idempotent CREATE INDEX IF NOT EXISTS.
  for (const [table, idxName] of [
    ['brain_decisions', 'idx_brain_decisions_peer_scope'],
    ['brain_patterns', 'idx_brain_patterns_peer_scope'],
    ['brain_learnings', 'idx_brain_learnings_peer_scope'],
    ['brain_observations', 'idx_brain_observations_peer_scope'],
  ] as const) {
    nativeDb.exec(`CREATE INDEX IF NOT EXISTS ${idxName} ON ${table} (peer_id, peer_scope)`);
  }

  // T1001: brain_promotion_log — typed promotion audit trail.
  // One row per observation evaluated (and promoted) by promoteObservationsToTyped().
  nativeDb.exec(
    `CREATE TABLE IF NOT EXISTS brain_promotion_log (
      id TEXT PRIMARY KEY,
      observation_id TEXT NOT NULL,
      from_tier TEXT NOT NULL,
      to_tier TEXT NOT NULL,
      score REAL NOT NULL,
      decided_at TEXT NOT NULL DEFAULT (datetime('now')),
      decided_by TEXT NOT NULL DEFAULT 'composite-scorer',
      rationale_json TEXT
    )`,
  );
  nativeDb.exec(
    `CREATE INDEX IF NOT EXISTS idx_promotion_log_observation
      ON brain_promotion_log (observation_id)`,
  );
  nativeDb.exec(
    `CREATE INDEX IF NOT EXISTS idx_promotion_log_decided_at
      ON brain_promotion_log (decided_at)`,
  );
  nativeDb.exec(
    `CREATE INDEX IF NOT EXISTS idx_promotion_log_to_tier
      ON brain_promotion_log (to_tier)`,
  );
  nativeDb.exec(
    `CREATE INDEX IF NOT EXISTS idx_promotion_log_score
      ON brain_promotion_log (score)`,
  );

  // T1003: brain_backfill_runs — staged backfill audit log.
  // CREATE IF NOT EXISTS so re-runs on existing databases are safe.
  // Staged rows are held in rollback_snapshot_json until approved/rolled-back.
  nativeDb.exec(
    `CREATE TABLE IF NOT EXISTS brain_backfill_runs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'staged',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      approved_at TEXT,
      rows_affected INTEGER NOT NULL DEFAULT 0,
      rollback_snapshot_json TEXT,
      source TEXT NOT NULL DEFAULT 'unknown',
      target_table TEXT NOT NULL DEFAULT 'brain_observations',
      approved_by TEXT
    )`,
  );
  nativeDb.exec(
    `CREATE INDEX IF NOT EXISTS idx_backfill_runs_status
      ON brain_backfill_runs (status)`,
  );
  nativeDb.exec(
    `CREATE INDEX IF NOT EXISTS idx_backfill_runs_kind
      ON brain_backfill_runs (kind)`,
  );
  nativeDb.exec(
    `CREATE INDEX IF NOT EXISTS idx_backfill_runs_created_at
      ON brain_backfill_runs (created_at)`,
  );
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
