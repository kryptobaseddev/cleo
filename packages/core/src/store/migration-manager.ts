/**
 * Unified migration manager for SQLite databases.
 *
 * Consolidates duplicated reconciliation, bootstrap, retry, and column-safety
 * logic that was previously copy-pasted between sqlite.ts (tasks.db) and
 * brain-sqlite.ts (brain.db). Both modules now delegate to these shared functions.
 *
 * @task T132
 * @see https://github.com/anthropics/cleo/issues/82
 * @see https://github.com/anthropics/cleo/issues/63
 * @see https://github.com/anthropics/cleo/issues/65
 */

import { copyFileSync, existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';
import { getLogger } from '../logger.js';

/** Required column definition for ensureColumns(). */
export interface RequiredColumn {
  name: string;
  /** ALTER TABLE ADD COLUMN DDL suffix (e.g., 'text', 'integer DEFAULT 0'). */
  ddl: string;
}

/** Migration retry constants for SQLITE_BUSY handling (T5185). */
const MAX_MIGRATION_RETRIES = 5;
const MIGRATION_RETRY_BASE_DELAY_MS = 100;
const MIGRATION_RETRY_MAX_DELAY_MS = 2000;

/**
 * Check whether a table exists in a SQLite database.
 */
export function tableExists(nativeDb: DatabaseSync, tableName: string): boolean {
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

/**
 * Create a pre-migration safety backup of the database file.
 *
 * Only creates the backup once (idempotent). Non-fatal on failure.
 */
export function createSafetyBackup(dbPath: string): void {
  const backupPath = dbPath.replace(/\.db$/, '-pre-cleo.db.bak');
  if (!existsSync(backupPath)) {
    try {
      copyFileSync(dbPath, backupPath);
    } catch {
      /* non-fatal */
    }
  }
}

/**
 * Insert a journal entry including `name` so Drizzle v1 beta (which checks by name,
 * not hash) correctly identifies the migration as already applied.
 *
 * Emits INSERT OR IGNORE to avoid duplicate-row errors when called defensively.
 */
function insertJournalEntry(
  nativeDb: DatabaseSync,
  hash: string,
  createdAt: number,
  name: string,
): void {
  // Ensure the name and applied_at columns exist (Drizzle v1 beta schema).
  // These are added by upgradeSyncIfNeeded, but reconcileJournal may run before
  // the first migrate() call that triggers the upgrade.
  const columns = nativeDb.prepare('PRAGMA table_info("__drizzle_migrations")').all() as Array<{
    name: string;
  }>;
  const colNames = new Set(columns.map((c) => c.name));
  if (!colNames.has('name')) {
    nativeDb.exec('ALTER TABLE "__drizzle_migrations" ADD COLUMN "name" text');
  }
  if (!colNames.has('applied_at')) {
    nativeDb.exec('ALTER TABLE "__drizzle_migrations" ADD COLUMN "applied_at" TEXT');
  }

  nativeDb.exec(
    `INSERT OR IGNORE INTO "__drizzle_migrations" ("hash", "created_at", "name") VALUES ('${hash}', ${createdAt}, '${name}')`,
  );
}

/**
 * Bootstrap and reconcile the Drizzle migration journal.
 *
 * Handles four scenarios:
 * 1. Tables exist but no __drizzle_migrations — bootstrap baseline as applied
 * 2. Journal has orphaned hashes (from older CLEO version) — clear and re-mark all as applied
 * 3. Journal exists but is missing entries for migrations whose DDL has already been applied
 *    (e.g., ALTER TABLE ADD COLUMN ran but journal entry was never written — happens when
 *    migrations are cherry-picked from worktrees or the process crashes mid-migration).
 *    Auto-inserts the missing journal entry so Drizzle skips the migration instead of
 *    re-running ALTER TABLE and crashing on "duplicate column name".
 * 4. Journal entries exist but have null `name` — Drizzle v1 beta identifies applied
 *    migrations by name, so entries without a name are invisible to it, causing already-
 *    applied migrations to be re-run and fail with "duplicate column name". Backfills
 *    the name from the local migration file matched by hash.
 *
 * @param nativeDb - Native SQLite database handle
 * @param migrationsFolder - Path to the drizzle migrations folder
 * @param existenceTable - A table name used to detect if the DB has data (e.g., 'tasks' or 'brain_decisions')
 * @param logSubsystem - Logger subsystem name for reconciliation warnings
 */
export function reconcileJournal(
  nativeDb: DatabaseSync,
  migrationsFolder: string,
  existenceTable: string,
  logSubsystem: string,
): void {
  // Scenario 1: Tables exist but no migration journal — bootstrap baseline
  if (tableExists(nativeDb, existenceTable) && !tableExists(nativeDb, '__drizzle_migrations')) {
    const migrations = readMigrationFiles({ migrationsFolder });
    const baseline = migrations[0];
    if (baseline) {
      nativeDb.exec(`
        CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
          id INTEGER PRIMARY KEY,
          hash text NOT NULL,
          created_at numeric,
          name text,
          applied_at TEXT
        )
      `);
      insertJournalEntry(nativeDb, baseline.hash, baseline.folderMillis, baseline.name ?? '');
    }
  }

  // Scenario 2: Journal has orphaned entries from a previous CLEO version
  if (tableExists(nativeDb, '__drizzle_migrations') && tableExists(nativeDb, existenceTable)) {
    const localMigrations = readMigrationFiles({ migrationsFolder });
    const localHashes = new Set(localMigrations.map((m) => m.hash));
    const dbEntries = nativeDb.prepare('SELECT hash FROM "__drizzle_migrations"').all() as Array<{
      hash: string;
    }>;
    const hasOrphanedEntries = dbEntries.some((e) => !localHashes.has(e.hash));

    if (hasOrphanedEntries) {
      const log = getLogger(logSubsystem);
      log.warn(
        { orphaned: dbEntries.filter((e) => !localHashes.has(e.hash)).length },
        `Detected stale migration journal entries from a previous CLEO version. Reconciling.`,
      );
      nativeDb.exec('DELETE FROM "__drizzle_migrations"');
      for (const m of localMigrations) {
        insertJournalEntry(nativeDb, m.hash, m.folderMillis, m.name ?? '');
      }
    }
  }

  // Scenario 3: Journal exists but is missing entries for already-applied migrations.
  // Detects migrations whose DDL columns already exist in the database but whose
  // journal entry was never written (e.g., cherry-picked from a worktree, or process
  // crashed after the ALTER TABLE succeeded but before the journal INSERT committed).
  if (tableExists(nativeDb, '__drizzle_migrations') && tableExists(nativeDb, existenceTable)) {
    const localMigrations = readMigrationFiles({ migrationsFolder });
    const journalEntries = nativeDb
      .prepare('SELECT hash FROM "__drizzle_migrations"')
      .all() as Array<{ hash: string }>;
    const journaledHashes = new Set(journalEntries.map((e) => e.hash));

    for (const migration of localMigrations) {
      if (journaledHashes.has(migration.hash)) continue;

      // Parse the migration SQL for ALTER TABLE ... ADD COLUMN statements.
      // drizzle's readMigrationFiles returns sql as string[] (one entry per
      // statement-breakpoint-separated statement), so join them for regex scanning.
      const alterColumnRegex = /ALTER\s+TABLE\s+[`"]?(\w+)[`"]?\s+ADD\s+COLUMN\s+[`"]?(\w+)[`"]?/gi;
      const alterMatches: Array<{ table: string; column: string }> = [];
      const sqlStatements = Array.isArray(migration.sql) ? migration.sql : [migration.sql ?? ''];
      const fullSql = sqlStatements.join('\n');
      for (const m of fullSql.matchAll(alterColumnRegex)) {
        alterMatches.push({ table: m[1] as string, column: m[2] as string });
      }

      // Only auto-reconcile migrations that consist entirely of ALTER TABLE ADD COLUMN
      // statements (and contain at least one). Pure CREATE INDEX / DROP INDEX migrations
      // that have no journal entry are genuinely pending and must run normally.
      if (alterMatches.length === 0) continue;

      // Check whether all ADD COLUMN targets already exist in their tables.
      const allColumnsExist = alterMatches.every(({ table, column }) => {
        if (!tableExists(nativeDb, table)) return false;
        const cols = nativeDb.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name: string;
        }>;
        return cols.some((c) => c.name === column);
      });

      if (allColumnsExist) {
        const log = getLogger(logSubsystem);
        log.warn(
          { migration: migration.name, columns: alterMatches },
          `Detected partially-applied migration ${migration.name} — columns exist but journal entry missing. Auto-reconciling.`,
        );
        insertJournalEntry(nativeDb, migration.hash, migration.folderMillis, migration.name ?? '');
      }
    }
  }

  // Scenario 4: Journal entries exist but have null `name`.
  //
  // Drizzle v1 beta changed getMigrationsToRun to filter by `name` (not hash).
  // Journal entries inserted by older CLEO code (INSERT without "name") have
  // name = null, which Drizzle filters out — making it treat those migrations as
  // unapplied and re-run them. This causes "duplicate column name" failures for
  // migrations whose DDL has already been applied.
  //
  // Fix: backfill `name` for any journal entries that have name = null but whose
  // hash matches a known local migration file.
  if (tableExists(nativeDb, '__drizzle_migrations') && tableExists(nativeDb, existenceTable)) {
    // Check if the name column exists before querying it
    const migCols = nativeDb.prepare('PRAGMA table_info("__drizzle_migrations")').all() as Array<{
      name: string;
    }>;
    const hasMigNameCol = migCols.some((c) => c.name === 'name');
    if (!hasMigNameCol) return; // name column absent — upgradeSyncIfNeeded will handle it

    const localMigrations = readMigrationFiles({ migrationsFolder });
    const hashToName = new Map(localMigrations.map((m) => [m.hash, m.name ?? '']));

    const unnamedEntries = nativeDb
      .prepare('SELECT id, hash FROM "__drizzle_migrations" WHERE name IS NULL')
      .all() as Array<{ id: number; hash: string }>;

    for (const entry of unnamedEntries) {
      const migrationName = hashToName.get(entry.hash);
      if (!migrationName) continue; // orphaned entry — leave for Scenario 2

      const log = getLogger(logSubsystem);
      log.warn(
        { id: entry.id, hash: entry.hash, name: migrationName },
        `Backfilling missing name on journal entry id=${entry.id} — Drizzle v1 beta requires name for applied-migration detection.`,
      );
      nativeDb.exec(
        `UPDATE "__drizzle_migrations" SET "name" = '${migrationName}' WHERE id = ${entry.id}`,
      );
    }
  }
}

/**
 * Check whether an error is a SQLite "duplicate column name" error.
 *
 * These are thrown when an ALTER TABLE ADD COLUMN statement is re-executed
 * after the column was already added (Scenario 3 in reconcileJournal).
 */
export function isDuplicateColumnError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /duplicate column name/i.test(err.message);
}

/**
 * Run Drizzle migrations with SQLITE_BUSY retry and exponential backoff.
 *
 * Also handles "duplicate column name" errors (Scenario 3): if Drizzle tries to
 * re-apply a migration whose DDL columns already exist (journal entry missing),
 * this function calls reconcileJournal again to insert the missing entry and
 * retries migrate() once more. This is the belt-and-suspenders safety net for
 * any partial migration that slips through the proactive reconcileJournal check.
 *
 * @param db - Drizzle database instance
 * @param migrationsFolder - Path to the drizzle migrations folder
 * @param nativeDb - Optional native SQLite handle for duplicate-column auto-reconcile
 * @param existenceTable - Optional existence-check table name for auto-reconcile
 * @param logSubsystem - Optional logger subsystem name for auto-reconcile warnings
 */
export function migrateWithRetry(
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle's NodeSQLiteDatabase is generic — accepting any schema avoids coupling to a specific schema type
  db: NodeSQLiteDatabase<any>,
  migrationsFolder: string,
  nativeDb?: DatabaseSync,
  existenceTable?: string,
  logSubsystem?: string,
): void {
  let duplicateColumnReconciled = false;

  for (let attempt = 1; attempt <= MAX_MIGRATION_RETRIES; attempt++) {
    try {
      migrate(db, { migrationsFolder });
      return;
    } catch (err) {
      // Belt-and-suspenders: if Drizzle hits a duplicate column name error on
      // the first attempt and we have the native DB handle, run Scenario 3
      // reconcileJournal and retry once. This catches any partial migration that
      // slipped through the proactive check run before migrateWithRetry.
      if (
        isDuplicateColumnError(err) &&
        !duplicateColumnReconciled &&
        nativeDb !== undefined &&
        existenceTable !== undefined &&
        logSubsystem !== undefined
      ) {
        duplicateColumnReconciled = true;
        reconcileJournal(nativeDb, migrationsFolder, existenceTable, logSubsystem);
        continue;
      }

      if (!isSqliteBusy(err) || attempt === MAX_MIGRATION_RETRIES) {
        throw err;
      }
      const delay = Math.min(
        MIGRATION_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) * (1 + Math.random() * 0.5),
        MIGRATION_RETRY_MAX_DELAY_MS,
      );
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.round(delay));
    }
  }
}

/**
 * Ensure all required columns exist on a table.
 *
 * Uses PRAGMA table_info to inspect the schema and adds any missing columns
 * via ALTER TABLE ADD COLUMN. Safety net for databases where Drizzle migrations
 * could not run due to journal corruption or version skew.
 *
 * @param nativeDb - Native SQLite database handle
 * @param tableName - Table to check (e.g., 'tasks')
 * @param requiredColumns - Columns that must exist
 * @param logSubsystem - Logger subsystem name
 */
export function ensureColumns(
  nativeDb: DatabaseSync,
  tableName: string,
  requiredColumns: RequiredColumn[],
  logSubsystem: string,
): void {
  if (!tableExists(nativeDb, tableName)) return;
  if (requiredColumns.length === 0) return;

  const columns = nativeDb.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name: string;
  }>;
  const existingCols = new Set(columns.map((c) => c.name));

  for (const req of requiredColumns) {
    if (!existingCols.has(req.name)) {
      const log = getLogger(logSubsystem);
      log.warn(
        { column: req.name },
        `Adding missing column ${tableName}.${req.name} via ALTER TABLE`,
      );
      nativeDb.exec(`ALTER TABLE ${tableName} ADD COLUMN ${req.name} ${req.ddl}`);
    }
  }
}
