/**
 * SQLite store via drizzle-orm/node-sqlite + node:sqlite (DatabaseSync).
 *
 * ## E6-L1 — thin-facade migration (T11521)
 *
 * `getDb()` and `getNativeTasksDb()` are now thin facades that delegate the
 * database open to {@link openDualScopeDb}('project', cwd) — the canonical
 * dual-scope chokepoint introduced by E3/E4 (T11512/T11517). This ensures:
 *
 * - Every tasks.db open flows through the single pragma SSoT (ADR-068/069).
 * - The worktree-isolation guard (T9806) fires consistently on all opens.
 * - DB Open Guard Gate 3 (`scripts/lint-no-direct-db-open.mjs`) stays green.
 *
 * The legacy tables (`tasks`, `sessions`, `schema_meta`, …) are still created
 * by `runMigrations` (drizzle-tasks folder) inside the shared `cleo.db` file
 * during the E3→E6 transition period, co-existing with the new `tasks_tasks`
 * prefix tables from the consolidated schema. E6-L7/L8 will remove them.
 *
 * @epic T4454
 * @task T4817 - node:sqlite engine migration (ADR-006, ADR-010)
 * @task T4810 - Data loss prevention guards
 * @task T11521 - E6-L1: route getDb through openDualScopeDb (SG-DB-SUBSTRATE-V2)
 */

import { copyFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
// T11280: `drizzle` is loaded LAZILY (see _getDrizzle) rather than via a
// top-level value import. drizzle-orm/node-sqlite/driver.js statically imports
// `node:sqlite`, so an eager value import here would pull the native binding in
// at module-load — defeating the lazy-init invariant proven by
// sqlite-lazy-init.test.ts ("importing sqlite.ts does NOT require node:sqlite at
// module-load time", T1331). The type import is erased at runtime and is safe.
import type { drizzle as drizzleFn, NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { getLogger } from '../logger.js';
import { resolveCleoDir } from '../paths.js';
// T11521: dual-scope chokepoint — all tasks.db opens now flow through here.
// openDualScopeDb manages the DatabaseSync lifecycle, pragmas, and migrations
// for the consolidated cleo.db. We extract the native handle and re-wrap it
// with the legacy tasks-schema drizzle instance for E6 caller compatibility.
import { openDualScopeDb, resolveDualScopeDbPath } from './dual-scope-db.js';
import type { RequiredColumn } from './migration-manager.js';
import {
  createSafetyBackup,
  ensureColumns,
  migrateWithRetry,
  reconcileJournal,
  tableExists,
} from './migration-manager.js';
import { resolveCorePackageMigrationsFolder } from './resolve-migrations-folder.js';
import { listSqliteBackups } from './sqlite-backup.js';
import { assertDbPathIsNotWorktreeResident } from './worktree-isolation-guard.js';

// node:sqlite access is isolated in the leaf module sqlite-native.ts to prevent
// TDZ circular-import failures in the agent-resolver → dispatch-trace →
// extraction-gate → graph-auto-populate → memory-sqlite → sqlite.ts cycle
// (T1325/T1331). See sqlite-native.ts for the full explanation.
//
// v3 (T1331): sqlite.ts has ZERO value-binding imports from sqlite-native.ts.
// openNativeDatabase now lives in sqlite-native.ts and is re-exported here for
// backwards compatibility. Re-exports are live-binding getters in Vite SSR —
// they cannot create TDZ bindings during module initialization.
export { type DatabaseSync, openNativeDatabase } from './sqlite-native.js';

// Type-only import for internal use (annotations on _nativeDb, runMigrations, etc.).
// Type-only imports are erased at compile time and produce no Vite SSR binding.
import type { DatabaseSync } from './sqlite-native.js';

import * as schema from './tasks-schema.js';

/**
 * Cached `drizzle` factory from `drizzle-orm/node-sqlite`, loaded on first use.
 *
 * Loaded via `createRequire` rather than a top-level import so that importing
 * `sqlite.ts` does not eagerly pull in `node:sqlite` (which the drizzle driver
 * statically imports). Memoized after the first call. Mirrors the
 * `getDbSyncConstructor` lazy pattern in sqlite-native.ts (T1331/T11280).
 *
 * @internal
 */
let _drizzle: typeof drizzleFn | null = null;

/**
 * Returns the `drizzle` factory, loading `drizzle-orm/node-sqlite` on first call.
 *
 * @internal
 * @task T11280
 */
function _getDrizzle(): typeof drizzleFn {
  if (_drizzle === null) {
    const _require = createRequire(import.meta.url);
    const mod = _require('drizzle-orm/node-sqlite') as { drizzle: typeof drizzleFn };
    _drizzle = mod.drizzle;
  }
  return _drizzle;
}

/** Database file name within .cleo/ directory (legacy — tasks.db is superseded by cleo.db in E6). */
const DB_FILENAME = 'tasks.db';

/** Schema version for newly created databases. Single source of truth. */
export const SQLITE_SCHEMA_VERSION = '2.0.0';
const SCHEMA_VERSION = SQLITE_SCHEMA_VERSION;

/** Singleton state for lazy initialization. */
let _db: NodeSQLiteDatabase<typeof schema> | null = null;
let _nativeDb: DatabaseSync | null = null;
let _dbPath: string | null = null;
/** Guard against concurrent initialization (async migration). */
let _initPromise: Promise<NodeSQLiteDatabase<typeof schema>> | null = null;

/**
 * Get the path to the SQLite database file.
 *
 * @deprecated In E6 the tasks domain lives in `cleo.db` (via `openDualScopeDb`).
 * This function remains for callers that check file existence; it continues to
 * return the legacy `tasks.db` path for backward compatibility.
 */
export function getDbPath(cwd?: string): string {
  return join(resolveCleoDir(cwd), DB_FILENAME);
}

/**
 * Minimum task count in a backup to consider it a valid recovery source.
 * Prevents restoring from a backup that's also empty or nearly empty.
 * @task T5188
 */
const MIN_BACKUP_TASK_COUNT = 10;

/**
 * Auto-recover from backup if the database has tables but zero tasks
 * and a backup with data exists.
 *
 * Root cause (T5188): WAL/SHM files were tracked by git. On branch switch,
 * git overwrites the WAL with an empty (committed) version, discarding all
 * pending WAL writes. The main DB file (which may not have been checkpointed)
 * appears empty because all recent writes were in the WAL.
 *
 * This function runs after migrations (so tables exist) and before the
 * singleton is set. It checks if the tasks table is empty and a VACUUM INTO
 * backup exists with real data. If so, it closes the current connection,
 * replaces the DB file from backup, and re-opens.
 *
 * @task T5188
 */
async function autoRecoverFromBackup(
  nativeDb: DatabaseSync,
  dbPath: string,
  cwd: string | undefined,
): Promise<void> {
  // Lazy import openNativeDatabase at runtime to avoid any static-import
  // binding on sqlite-native.ts at module-init time.
  const { openNativeDatabase } = await import('./sqlite-native.js');
  const log = getLogger('sqlite');

  try {
    // Count tasks in current database
    const countResult = nativeDb.prepare('SELECT COUNT(*) as cnt FROM tasks').get() as
      | { cnt: number }
      | undefined;
    const taskCount = countResult?.cnt ?? 0;

    if (taskCount > 0) return; // Database has data, no recovery needed

    // Database is empty — check for backups
    const backups = listSqliteBackups(cwd);
    if (backups.length === 0) {
      // No backups available — this is a genuinely new database
      return;
    }

    // Check the newest backup for task count
    const newestBackup = backups[0]!;

    // Open backup read-only to verify it has data.
    // Use openNativeDatabase (from sqlite-native.ts) — safe at runtime (no TDZ risk).
    const backupDb = openNativeDatabase(newestBackup.path, { readonly: true, enableWal: false });
    let backupTaskCount = 0;
    try {
      const backupCount = backupDb.prepare('SELECT COUNT(*) as cnt FROM tasks').get() as
        | { cnt: number }
        | undefined;
      backupTaskCount = backupCount?.cnt ?? 0;
    } finally {
      backupDb.close();
    }

    if (backupTaskCount < MIN_BACKUP_TASK_COUNT) {
      // Backup also has very few tasks — not a reliable recovery source
      return;
    }

    // We have an empty database AND a backup with data — auto-recover
    log.warn(
      { dbPath, backupPath: newestBackup.path, backupTasks: backupTaskCount },
      `Empty database detected with ${backupTaskCount}-task backup available. ` +
        'Auto-recovering from backup. This likely happened because git-tracked ' +
        'WAL/SHM files were overwritten during a branch switch (T5188).',
    );

    // Close current connection
    nativeDb.close();

    // Remove stale WAL/SHM files that may have been corrupted by git
    const walPath = dbPath + '-wal';
    const shmPath = dbPath + '-shm';
    try {
      unlinkSync(walPath);
    } catch {
      /* may not exist */
    }
    try {
      unlinkSync(shmPath);
    } catch {
      /* may not exist */
    }

    // Restore from backup (atomic: copy to temp, rename)
    const tempPath = dbPath + '.recovery-tmp';
    copyFileSync(newestBackup.path, tempPath);

    // Rename in place — on the same filesystem this is atomic
    renameSync(tempPath, dbPath);

    log.info(
      { dbPath, backupPath: newestBackup.path, restoredTasks: backupTaskCount },
      'Database auto-recovered from backup successfully.',
    );

    // Re-open the restored database — update the native singleton
    const restoredNativeDb = openNativeDatabase(dbPath);
    _nativeDb = restoredNativeDb;

    // Re-run migrations on restored DB to ensure schema is current
    const restoredDb = _getDrizzle()({ client: restoredNativeDb, schema });
    runMigrations(restoredNativeDb, restoredDb);

    // Update the singleton drizzle instance
    _db = restoredDb;
  } catch (err) {
    // Auto-recovery failure is non-fatal — log and continue with empty DB
    log.error({ err, dbPath }, 'Auto-recovery from backup failed. Continuing with empty database.');
  }
}

/**
 * Open (or return cached) the drizzle tasks-schema handle for the project scope.
 *
 * ## E6-L1 façade (T11521)
 *
 * Delegates the physical DB open to {@link openDualScopeDb}('project', cwd) —
 * the canonical dual-scope chokepoint. The returned `NodeSQLiteDatabase` wraps
 * the same `DatabaseSync` handle as the consolidated `cleo.db` but is typed
 * against the legacy `tasks-schema` (table name `tasks`, etc.) so all existing
 * callers compile without change.
 *
 * The legacy drizzle-tasks migrations are still applied to this handle during
 * the E3→E6 transition, creating the `tasks` table family inside `cleo.db`
 * alongside the new `tasks_tasks` tables. E6-L7/L8 will remove them.
 *
 * Uses a promise guard so concurrent callers wait for the same
 * initialization to complete (migrations are async).
 */
export async function getDb(cwd?: string): Promise<NodeSQLiteDatabase<typeof schema>> {
  // T9961 / T9806: worktree-isolation guard — defense-in-depth for direct
  // getDb() callers that bypass openCleoDb('tasks', cwd).
  // Fires before any DB file is touched, matching the openCleoDb chokepoint.
  assertDbPathIsNotWorktreeResident('tasks', cwd);

  // Resolve the cleo.db path via the dual-scope helper (same logic as
  // openDualScopeDb uses internally) to drive the singleton key.
  const requestedPath = resolveDualScopeDbPath('project', cwd);

  // If singleton exists but points to different path, reset it
  if (_db && _dbPath !== requestedPath) {
    resetDbState();
  }

  if (_db) return _db;

  // If already initializing, wait for the in-flight init
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    // ── Dual-scope chokepoint delegation (T11521 · E6-L1) ─────────────────
    // openDualScopeDb applies pragma SSoT, creates the directory, runs cleo-project
    // migrations, and manages the singleton cache. We extract its native handle
    // so we can re-wrap it with the legacy tasks-schema for caller compatibility.
    const dualHandle = await openDualScopeDb('project', cwd);

    // Extract the underlying DatabaseSync. Drizzle exposes it via `$client`.
    const nativeDb = (dualHandle.db as { $client?: DatabaseSync }).$client ?? null;
    if (!nativeDb) {
      throw new Error(
        'E6-L1: openDualScopeDb returned a handle without $client — ' +
          'cannot extract DatabaseSync for legacy tasks-schema wrapping.',
      );
    }

    _nativeDb = nativeDb;
    _dbPath = requestedPath;

    // Wrap the native handle with the legacy tasks-schema drizzle instance.
    // This allows all existing callers (using schema.tasks, schema.sessions, etc.)
    // to continue querying the same DatabaseSync without change.
    const db = _getDrizzle()({ client: nativeDb, schema });

    // Run legacy drizzle-tasks migrations against the shared cleo.db handle.
    // During E3→E6 transition these create the old `tasks` table family alongside
    // the new `tasks_tasks` tables from the consolidated schema migration.
    runMigrations(nativeDb, db);

    // Migration SQL contains PRAGMA foreign_keys=ON statements.
    // In test environments, disable FKs after migration to allow test
    // fixtures to insert data without full referential integrity.
    if (process.env.VITEST) {
      nativeDb.exec('PRAGMA foreign_keys=OFF');
    }

    // Seed schema version for new databases (no-op if already set)
    nativeDb.exec(
      `INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('schemaVersion', '${SCHEMA_VERSION}')`,
    );
    nativeDb.exec(
      `INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('task_id_sequence', '{"counter":0,"lastId":"T000","checksum":"seed"}')`,
    );

    // Auto-recovery: detect empty database with available backups (T5188)
    // Root cause: git-tracked WAL/SHM files get overwritten on branch switch,
    // causing data loss when the WAL contained uncommitted writes.
    await autoRecoverFromBackup(nativeDb, requestedPath, cwd);

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
 * Resolve the absolute path to the drizzle-tasks migrations folder inside
 * @cleocode/core, using ESM-native module resolution (T1177).
 *
 * Delegates to {@link resolveCorePackageMigrationsFolder} which handles
 * bundled dist/, workspace dev, and global-install layouts uniformly via
 * `import.meta.resolve()` + `createRequire().resolve()` fallback.
 */
export function resolveMigrationsFolder(): string {
  return resolveCorePackageMigrationsFolder('drizzle-tasks');
}

/**
 * Check whether a table exists in the SQLite database.
 */
// tableExists, isSqliteBusy, retry constants — delegated to migration-manager.ts (T132)

/** Re-export isSqliteBusy for external consumers. */
export { isSqliteBusy } from './migration-manager.js';

const REQUIRED_TASK_COLUMNS: RequiredColumn[] = [
  { name: 'pipeline_stage', ddl: 'text' },
  { name: 'assignee', ddl: 'text' },
];

/**
 * Required columns that MUST exist on the sessions table before the
 * wave0-schema-hardening migration runs.
 *
 * The wave0 migration rebuilds the sessions table via:
 *   INSERT INTO __new_sessions(..., provider_id, stats_json, resume_count, grade_mode)
 *   SELECT ..., provider_id, stats_json, resume_count, grade_mode FROM sessions
 *
 * If an existing sessions table (created before these columns were added) is
 * missing any of them, the SELECT fails with "no such column". ensureColumns()
 * adds them as NULL-able columns before the migration runs, making the SELECT safe.
 *
 * @see https://github.com/anthropics/cleo/issues/83
 */
const REQUIRED_SESSION_COLUMNS: RequiredColumn[] = [
  { name: 'provider_id', ddl: 'text' },
  { name: 'stats_json', ddl: 'text' },
  { name: 'resume_count', ddl: 'integer' },
  { name: 'grade_mode', ddl: 'integer' },
  // T1118 L4a — owner-auth HMAC token for override authentication
  { name: 'owner_auth_token', ddl: 'text' },
];

/**
 * Run drizzle migrations to create/update tables.
 *
 * Delegates to shared migration-manager.ts for journal reconciliation,
 * retry logic, and column safety. See T132 for consolidation rationale.
 *
 * @task T4837 - ADR-012 drizzle-kit migration system
 * @task T5185 - Retry+backoff for SQLITE_BUSY during migrations
 * @task T132 - Unified migration system
 */
function runMigrations(nativeDb: DatabaseSync, db: NodeSQLiteDatabase<typeof schema>): void {
  const migrationsFolder = resolveMigrationsFolder();

  // Safety backup before any migration work
  if (tableExists(nativeDb, 'tasks') && _dbPath) {
    createSafetyBackup(_dbPath);
  }

  // Bootstrap baseline + reconcile stale journal entries
  reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'sqlite');

  // Pre-migration column safety: ensure sessions table has the columns that the
  // wave0-schema-hardening migration SELECTs during its table rebuild. Without
  // this, upgrading from a pre-wave0 DB fails with "no such column: provider_id".
  // Must run BEFORE migrateWithRetry so the migration's INSERT...SELECT succeeds.
  // @see https://github.com/anthropics/cleo/issues/83
  ensureColumns(nativeDb, 'sessions', REQUIRED_SESSION_COLUMNS, 'sqlite');

  // Run pending migrations with SQLITE_BUSY retry.
  // Pass nativeDb + existenceTable so migrateWithRetry can auto-reconcile any
  // partial migration (Scenario 3) that slips through the proactive check above.
  migrateWithRetry(db, migrationsFolder, nativeDb, 'tasks', 'sqlite');

  // Defensive column safety net
  ensureColumns(nativeDb, 'tasks', REQUIRED_TASK_COLUMNS, 'sqlite');

  // T11181 — version-ssot columns (owner_version, doc_version)
  // These columns are defined in the attachments schema but may not exist
  // in databases created before the T11181 migration was wired in.
  for (const stmt of [
    'ALTER TABLE attachments ADD COLUMN owner_version TEXT',
    'ALTER TABLE attachments ADD COLUMN doc_version INTEGER NOT NULL DEFAULT 1',
  ]) {
    try {
      nativeDb.exec(stmt);
    } catch {
      /* column may already exist */
    }
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
  _initPromise = null;
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
  _initPromise = null;
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
 *
 * @deprecated In E6 the tasks domain lives in `cleo.db`. This check returns
 * whether the legacy `tasks.db` file exists for backward-compat callers.
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
 * Get the underlying node:sqlite DatabaseSync instance for tasks.db.
 *
 * ## E6-L1 façade (T11521)
 *
 * Thin facade delegating to {@link getNativeDb}. After the chokepoint
 * migration the native handle originates from {@link openDualScopeDb} —
 * callers receive the same `DatabaseSync` from `cleo.db`.
 */
export function getNativeTasksDb(): DatabaseSync | null {
  return _nativeDb;
}

export type { NodeSQLiteDatabase };
/**
 * Re-export schema for external use.
 */
export { schema };

/**
 * Close ALL database singletons (tasks.db, brain.db, nexus.db).
 *
 * Must be called before deleting temp directories on Windows, where
 * SQLite holds exclusive file handles on .db, .db-wal, and .db-shm files.
 * Safe to call even if some databases were never opened.
 *
 * @task T5508
 */
export async function closeAllDatabases(): Promise<void> {
  // Close tasks.db
  closeDb();

  // Close brain.db (dynamic import to avoid circular deps)
  try {
    const { closeBrainDb } = await import('./memory-sqlite.js');
    closeBrainDb();
  } catch {
    /* module may not be loaded */
  }

  // Close nexus.db (dynamic import to avoid circular deps)
  try {
    const { closeNexusDb } = await import('./nexus-sqlite.js');
    closeNexusDb();
  } catch {
    /* module may not be loaded */
  }
}
