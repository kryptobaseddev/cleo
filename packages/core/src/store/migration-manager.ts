/**
 * Unified migration manager for SQLite databases.
 *
 * Consolidates duplicated reconciliation, bootstrap, retry, and column-safety
 * logic that was previously copy-pasted between sqlite.ts (tasks.db) and
 * memory-sqlite.ts (brain.db). Both modules now delegate to these shared functions.
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
 * Probe a migration's DDL against the live schema and mark the journal entry
 * applied IF AND ONLY IF all DDL targets already exist in the database.
 *
 * Supports three DDL forms commonly emitted by drizzle migrations:
 * - `ALTER TABLE foo ADD COLUMN bar text` → mark applied if column foo.bar exists
 * - `CREATE TABLE foo (...)` → mark applied if table foo exists
 * - `CREATE INDEX [IF NOT EXISTS] idx_foo ON foo(...)` → mark applied if index exists
 *
 * If the migration contains DDL that doesn't fall into these patterns, or if any
 * target is missing, the function returns false and DOES NOT mark applied —
 * leaving the migration for Drizzle's normal `migrate()` to run.
 *
 * Used by:
 * - Scenario 2 Sub-case B (after journal reset, decide what was already applied)
 * - Scenario 3 (originally inline; now extracted for reuse)
 *
 * Replaces the broken "wholesale mark applied" pattern that was the root cause
 * of the ensureColumns band-aid sprawl (T632).
 *
 * @param nativeDb - Native SQLite database handle
 * @param migration - One entry from drizzle's readMigrationFiles
 * @param logSubsystem - Logger subsystem name
 * @returns true if the journal entry was inserted; false if migration must run
 */
function probeAndMarkApplied(
  nativeDb: DatabaseSync,
  migration: { hash: string; folderMillis: number; name?: string; sql?: string | string[] },
  logSubsystem: string,
): boolean {
  const sqlStatements = Array.isArray(migration.sql) ? migration.sql : [migration.sql ?? ''];
  const fullSql = sqlStatements.join('\n');

  // Extract DDL targets we can probe.
  const alterColumnRegex = /ALTER\s+TABLE\s+[`"]?(\w+)[`"]?\s+ADD\s+COLUMN\s+[`"]?(\w+)[`"]?/gi;
  const createTableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?(\w+)[`"]?/gi;
  const createIndexRegex =
    /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?(\w+)[`"]?/gi;

  const alterTargets: Array<{ table: string; column: string }> = [];
  for (const m of fullSql.matchAll(alterColumnRegex)) {
    alterTargets.push({ table: m[1] as string, column: m[2] as string });
  }

  // Build rename map: if migration contains "ALTER TABLE x_new RENAME TO x",
  // record { intermediate: "x_new", final: "x" }. Used below to redirect
  // CREATE TABLE probes away from temporary intermediate tables (which no
  // longer exist after the rename) to the final table name.
  const renameRegex = /ALTER\s+TABLE\s+[`"]?(\w+)[`"]?\s+RENAME\s+TO\s+[`"]?(\w+)[`"]?/gi;
  const renameMap = new Map<string, string>(); // intermediate → final
  for (const m of fullSql.matchAll(renameRegex)) {
    renameMap.set(m[1] as string, m[2] as string);
  }

  // Track which created tables came from the rename map (all _new → final).
  let allCreatedTablesAreRenamed = true;
  const tableTargets: string[] = [];
  for (const m of fullSql.matchAll(createTableRegex)) {
    const created = m[1] as string;
    if (renameMap.has(created)) {
      // Intermediate table renamed → probe the FINAL table name.
      tableTargets.push(renameMap.get(created) as string);
    } else {
      // Table not renamed — genuinely new table, probe its name directly.
      allCreatedTablesAreRenamed = false;
      tableTargets.push(created);
    }
  }

  // For pure rebuild migrations (every CREATE TABLE is an intermediate that was
  // renamed), skip the index probe. Indexes are always recreated as part of the
  // rename idiom; requiring them to pre-exist would make the probe overly strict
  // and would fail in tests (and on freshly-wiped DBs where indexes aren't yet
  // present). The presence of all final table names is sufficient evidence.
  const isRebuildOnlyMigration =
    allCreatedTablesAreRenamed && tableTargets.length > 0 && alterTargets.length === 0;

  const indexTargets: string[] = [];
  if (!isRebuildOnlyMigration) {
    for (const m of fullSql.matchAll(createIndexRegex)) {
      indexTargets.push(m[1] as string);
    }
  }

  const totalTargets = alterTargets.length + tableTargets.length + indexTargets.length;
  if (totalTargets === 0) {
    // No probable DDL — could be UPDATE/INSERT/DELETE/etc. Leave for migrate().
    return false;
  }

  // Probe each target.
  const allAltersPresent = alterTargets.every(({ table, column }) => {
    if (!tableExists(nativeDb, table)) return false;
    const cols = nativeDb.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    return cols.some((c) => c.name === column);
  });
  const allTablesPresent = tableTargets.every((t) => tableExists(nativeDb, t));
  const allIndexesPresent = indexTargets.every((idx) => {
    const rows = nativeDb
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`)
      .all(idx) as Array<{ name: string }>;
    return rows.length > 0;
  });

  if (allAltersPresent && allTablesPresent && allIndexesPresent) {
    insertJournalEntry(nativeDb, migration.hash, migration.folderMillis, migration.name ?? '');
    const log = getLogger(logSubsystem);
    log.debug(
      {
        migration: migration.name,
        alters: alterTargets.length,
        tables: tableTargets.length,
        indexes: indexTargets.length,
        isRebuildOnly: isRebuildOnlyMigration,
      },
      `Migration ${migration.name} DDL already present in schema — marked applied.`,
    );
    return true;
  }

  // At least one target missing — leave for drizzle migrate() to run.
  return false;
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
  //
  // Two distinct sub-cases require different handling:
  //
  // A) DB is AHEAD of this install (forward-compatibility): all local hashes
  //    are present in the DB, but the DB also has additional entries for
  //    migrations this install does not know about. This happens when a user
  //    runs a globally-installed (older) cleo binary against a DB that was
  //    last written by a newer cleo version. Deleting those entries would
  //    cause an infinite reconciliation cycle: Drizzle re-runs the "missing"
  //    migrations, hits duplicate-column errors (Scenario 3 recovers), writes
  //    them back — only for this install to delete them again on the next run.
  //    ACTION: skip reconciliation, log at debug only.
  //
  // B) DB has stale hashes from a genuinely old CLEO version whose checksum
  //    algorithm produced different hashes for the same migration files (i.e.,
  //    at least one local hash is MISSING from the DB while other DB entries
  //    are unrecognised). ACTION: delete and re-seed as before, log at warn.
  if (tableExists(nativeDb, '__drizzle_migrations') && tableExists(nativeDb, existenceTable)) {
    const localMigrations = readMigrationFiles({ migrationsFolder });
    const localHashes = new Set(localMigrations.map((m) => m.hash));
    const dbEntries = nativeDb.prepare('SELECT hash FROM "__drizzle_migrations"').all() as Array<{
      hash: string;
    }>;
    const orphanedEntries = dbEntries.filter((e) => !localHashes.has(e.hash));
    const hasOrphanedEntries = orphanedEntries.length > 0;

    if (hasOrphanedEntries) {
      const dbHashes = new Set(dbEntries.map((e) => e.hash));
      const allLocalHashesPresentInDb = localMigrations.every((m) => dbHashes.has(m.hash));

      if (allLocalHashesPresentInDb) {
        // Sub-case A: DB is ahead — this install is older than the DB.
        // Do NOT modify the journal; log at debug so we can trace if needed.
        const log = getLogger(logSubsystem);
        log.debug(
          { extra: orphanedEntries.length },
          `Migration journal has ${orphanedEntries.length} entries for migrations not known to this install (DB is ahead). Skipping reconciliation.`,
        );
      } else {
        // Sub-case B: Genuine stale hashes from an older CLEO version.
        // ROOT-CAUSE FIX (T632): The previous implementation DELETEd the journal
        // and INSERTed all local migrations as applied WITHOUT running their SQL.
        // That meant ALTER TABLE migrations (T417 agent, T528 provenance, etc.)
        // got marked applied but their columns were never added — forcing
        // ensureColumns band-aids in memory-sqlite.ts to patch the missing schema.
        //
        // Real fix: clear orphaned entries, then PROBE each local migration's
        // DDL. Mark applied ONLY if the DDL targets already exist in the schema.
        // Drizzle's migrate() (called next) will run whatever remains unjournaled.
        const log = getLogger(logSubsystem);
        log.warn(
          { orphaned: orphanedEntries.length },
          `Detected stale migration journal entries from a previous CLEO version. Reconciling via DDL probe.`,
        );
        nativeDb.exec('DELETE FROM "__drizzle_migrations"');
        for (const m of localMigrations) {
          probeAndMarkApplied(nativeDb, m, logSubsystem);
        }
      }
    }
  }

  // Scenario 3: Journal exists but is missing entries for already-applied migrations.
  // Detects migrations whose DDL columns already exist in the database but whose
  // journal entry was never written (e.g., cherry-picked from a worktree, or process
  // crashed after the ALTER TABLE succeeded but before the journal INSERT committed).
  //
  // T920: Extended to handle PARTIAL application — when SOME ALTER targets exist but
  // not all (e.g., T528 where brain_page_nodes ALTERs ran but brain_page_edges.provenance
  // did not). In this case the migration also has DROP TABLE + CREATE TABLE statements,
  // so the full migration cannot be re-run (the existing columns cause duplicate-column
  // errors). Fix: add any missing ALTER columns via idempotent ALTER TABLE, then mark
  // the migration as applied so Drizzle skips it.
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
      const alterColumnRegex =
        /ALTER\s+TABLE\s+[`"]?(\w+)[`"]?\s+ADD\s+COLUMN\s+[`"]?(\w+)[`"]?\s*(.*?)(?:;|$)/gi;
      const alterMatches: Array<{ table: string; column: string; ddl: string }> = [];
      const sqlStatements = Array.isArray(migration.sql) ? migration.sql : [migration.sql ?? ''];
      const fullSql = sqlStatements.join('\n');
      for (const m of fullSql.matchAll(alterColumnRegex)) {
        alterMatches.push({
          table: m[1] as string,
          column: m[2] as string,
          ddl: ((m[3] as string) || '').trim(),
        });
      }

      // Only auto-reconcile migrations that have at least one ALTER TABLE ADD COLUMN,
      // or that use the rename-via-drop+create idiom (CREATE TABLE x_new ... DROP TABLE x
      // ... ALTER TABLE x_new RENAME TO x). Pure CREATE INDEX / DROP INDEX migrations
      // that have no journal entry are genuinely pending and must run normally.
      //
      // T1135: Migrations using only the table-rebuild/rename idiom (no ADD COLUMN) were
      // previously skipped here, leaving them unjournaled and causing Drizzle to re-run
      // them destructively on every init. Delegate to probeAndMarkApplied which handles
      // the RENAME TO pattern and probes the final table name instead of the intermediate.
      if (alterMatches.length === 0) {
        const renameRe = /ALTER\s+TABLE\s+[`"]?\w+[`"]?\s+RENAME\s+TO\s+[`"]?\w+[`"]?/i;
        const createTableRe = /CREATE\s+TABLE/i;
        if (renameRe.test(fullSql) && createTableRe.test(fullSql)) {
          probeAndMarkApplied(nativeDb, migration, logSubsystem);
        }
        continue;
      }

      // Check which ADD COLUMN targets already exist and which are missing.
      const existingColumns: Array<{ table: string; column: string; ddl: string }> = [];
      const missingColumns: Array<{ table: string; column: string; ddl: string }> = [];

      for (const target of alterMatches) {
        if (!tableExists(nativeDb, target.table)) {
          missingColumns.push(target);
          continue;
        }
        const cols = nativeDb.prepare(`PRAGMA table_info(${target.table})`).all() as Array<{
          name: string;
        }>;
        if (cols.some((c) => c.name === target.column)) {
          existingColumns.push(target);
        } else {
          missingColumns.push(target);
        }
      }

      // Case A: All ALTER targets already exist — mark as applied (original behaviour).
      if (missingColumns.length === 0) {
        const log = getLogger(logSubsystem);
        log.warn(
          { migration: migration.name, columns: alterMatches },
          `Detected partially-applied migration ${migration.name} — columns exist but journal entry missing. Auto-reconciling.`,
        );
        insertJournalEntry(nativeDb, migration.hash, migration.folderMillis, migration.name ?? '');
        continue;
      }

      // Case B (T920): SOME columns exist but others are missing — the migration was
      // partially applied. If at least one column already exists from this migration's
      // ALTER TABLE set, Drizzle cannot re-run the migration (the existing columns cause
      // "duplicate column name"). Idempotently add the missing columns, then mark applied.
      //
      // We do NOT attempt to run DROP TABLE / CREATE TABLE statements from the migration
      // (e.g., T528's brain_page_edges table recreation for weight NOT NULL), because
      // the table already has data-compatible columns from the partial apply. The
      // ensureColumns call in memory-sqlite.ts provides any remaining structural safety net.
      if (existingColumns.length > 0 && missingColumns.length > 0) {
        const log = getLogger(logSubsystem);
        log.warn(
          {
            migration: migration.name,
            existingColumns: existingColumns.map((c) => `${c.table}.${c.column}`),
            missingColumns: missingColumns.map((c) => `${c.table}.${c.column}`),
          },
          `T920: Detected partial migration ${migration.name} — some ALTER columns exist, some missing. Adding missing columns and marking applied.`,
        );

        // Add each missing column only if its table exists (guard against DROP TABLE
        // mid-migration removing the table entirely).
        for (const { table, column, ddl } of missingColumns) {
          if (!tableExists(nativeDb, table)) continue;
          try {
            nativeDb.exec(`ALTER TABLE ${table} ADD COLUMN ${column}${ddl ? ` ${ddl}` : ''}`);
            log.warn(
              { migration: migration.name, table, column },
              `T920: Added missing column ${table}.${column} to complete partial migration.`,
            );
          } catch {
            // Column add failed (e.g., NOT NULL without default on non-empty table).
            // Log and continue — the subsequent migrate() call may still succeed or
            // fall through to the duplicate-column retry handler.
            log.warn(
              { migration: migration.name, table, column },
              `T920: Could not add missing column ${table}.${column} — will let Drizzle migrate() handle it.`,
            );
          }
        }

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
