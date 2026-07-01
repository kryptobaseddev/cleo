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
import { eq } from 'drizzle-orm';
// T11280: `drizzle` is loaded LAZILY (see _getDrizzle) rather than via a
// top-level value import. drizzle-orm/node-sqlite/driver.js statically imports
// `node:sqlite`, so an eager value import here would pull the native binding in
// at module-load — defeating the lazy-init invariant proven by
// sqlite-lazy-init.test.ts ("importing sqlite.ts does NOT require node:sqlite at
// module-load time", T1331). The type import is erased at runtime and is safe.
import type { drizzle as drizzleFn, NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { getLogger } from '../logger.js';
// T11521: dual-scope chokepoint — all tasks.db opens now flow through here.
// openDualScopeDb manages the DatabaseSync lifecycle, pragmas, and migrations
// for the consolidated cleo.db. We extract the native handle and re-wrap it
// with the legacy tasks-schema drizzle instance for E6 caller compatibility.
import {
  _resetDualScopeDbCache,
  openDualScopeDb,
  resolveDualScopeDbPath,
} from './dual-scope-db.js';
import { withLock } from './lock.js';
import type { RequiredColumn } from './migration-manager.js';
import {
  createSafetyBackup,
  ensureColumns,
  migrateWithRetry,
  reconcileJournal,
  tableExists,
} from './migration-manager.js';
import {
  resolveConsolidatedJournalSiblings,
  resolveCorePackageMigrationsFolder,
} from './resolve-migrations-folder.js';
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
 * Get the path to the SQLite database file that {@link getDb} opens.
 *
 * ## E6-L1 (T11521)
 *
 * After the dual-scope migration, `getDb()` opens the consolidated project
 * `cleo.db` via {@link openDualScopeDb}. This function therefore returns the
 * dual-scope `cleo.db` path so that callers checking for the file `getDb()`
 * created (existence / backup / health probes) point at the correct file.
 */
export function getDbPath(cwd?: string): string {
  return resolveDualScopeDbPath('project', cwd);
}

/**
 * Minimum task count in a backup to consider it a valid recovery source.
 * Prevents restoring from a backup that's also empty or nearly empty.
 * @task T5188
 */
const MIN_BACKUP_TASK_COUNT = 10;

/**
 * Inter-process lock suffix shared by the two destructive first-open paths that
 * both fire on the `tasks_tasks == 0` (empty-consolidated-`cleo.db`) condition:
 *
 *  - {@link autoRecoverFromBackup} (T5188) — restore a `tasks-*.db` snapshot over
 *    the live `cleo.db` file (closes the handle, unlinks the WAL, overwrites the
 *    DB file via copy+rename).
 *  - `maybeRunExodusOnOpen` (`exodus/on-open.ts`, T11553) — copy the legacy fleet
 *    into the same `cleo.db` under a single-flight lock keyed by this suffix.
 *
 * Before T11662 these paths used DIFFERENT (or, for auto-recovery, NO) locks, so
 * they could run concurrently against the same file in two processes — one
 * unlinking the WAL while the other was mid-copy → a torn WAL frame and
 * `"database disk image is malformed"` (observed on a live 4 687-task DB under 3
 * concurrent agents).
 *
 * Auto-recovery now contends on the SAME lock the exodus path uses
 * (`<cleo.db>.exodus-on-open.lock`). Mutual exclusion is therefore guaranteed in
 * BOTH directions: while exodus holds the lock copying the fleet, auto-recovery
 * blocks; while auto-recovery holds it restoring a snapshot, exodus blocks. The
 * winner re-checks `tasks_tasks` under the lock (double-checked locking) and the
 * loser early-exits without touching the WAL or the DB file.
 *
 * @task T11662
 * @see packages/core/src/store/exodus/on-open.ts — the exodus single-flight lock
 */
const FIRST_OPEN_LOCK_SUFFIX = '.exodus-on-open.lock';

/**
 * Re-count `tasks_tasks` from a FRESH read-only handle on the on-disk `cleo.db`,
 * used as the double-checked-locking re-query inside {@link autoRecoverFromBackup}
 * (T11662). A fresh handle is required because the caller's `nativeDb` is about
 * to be (or has been) closed by the recovery path, and because another process
 * may have populated the file (exodus or a sibling auto-recovery) while we were
 * blocked acquiring the lock — a read through a stale cached handle would not see
 * those committed rows.
 *
 * Returns `0` on any read failure (missing table / unreadable file) so a failed
 * probe is treated as "still empty" and never falsely suppresses a needed
 * recovery (the subsequent restore is itself idempotent under the lock).
 *
 * @param dbPath - Absolute path to the consolidated project `cleo.db`.
 * @returns The current `tasks_tasks` row count, or `0` if it cannot be read.
 * @task T11662
 */
async function recountTasksFromDisk(dbPath: string): Promise<number> {
  const { openNativeDatabase } = await import('./sqlite-native.js');
  let probe: DatabaseSync | null = null;
  try {
    probe = openNativeDatabase(dbPath, { readonly: true, enableWal: false });
    const row = probe.prepare('SELECT COUNT(*) as cnt FROM tasks_tasks').get() as
      | { cnt: number }
      | undefined;
    return row?.cnt ?? 0;
  } catch {
    return 0;
  } finally {
    try {
      probe?.close();
    } catch {
      /* already closed / never opened */
    }
  }
}

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
 * ## Concurrency safety (T11662)
 *
 * The destructive restore (`close → unlink WAL → copy+rename DB file`) is wrapped
 * in an inter-process lock keyed by {@link FIRST_OPEN_LOCK_SUFFIX} — the SAME
 * lock the exodus first-open migration (`maybeRunExodusOnOpen`) uses. Both paths
 * fire on the identical `tasks_tasks == 0` condition, so without a shared lock
 * two processes could destroy the WAL / overwrite the DB file simultaneously,
 * producing a torn WAL frame (`"database disk image is malformed"`). Under the
 * lock the function re-queries `tasks_tasks` from a fresh on-disk handle
 * (double-checked locking); if another process already recovered/migrated the
 * data, it returns WITHOUT touching the WAL or DB file. Only the first winner
 * performs the restore.
 *
 * @task T5188
 * @task T11662
 */
/**
 * Count tasks in a backup snapshot, tolerant of the cutover (T11578 · AC1).
 *
 * Post-exodus snapshots of the consolidated `cleo.db` carry the prefixed
 * `tasks_tasks` table; legacy pre-consolidation `tasks.db` snapshots carry the
 * bare `tasks` table. Prefer the prefixed table, falling back to the bare one
 * when the prefixed table is absent, so auto-recovery keeps working across the
 * substrate transition.
 *
 * @param backupDb - Read-only handle to the backup snapshot.
 * @returns Task row count, or 0 if neither table exists / the read fails.
 */
function countBackupTasks(backupDb: DatabaseSync): number {
  for (const table of ['tasks_tasks', 'tasks']) {
    try {
      const row = backupDb.prepare(`SELECT COUNT(*) as cnt FROM "${table}"`).get() as
        | { cnt: number }
        | undefined;
      return row?.cnt ?? 0;
    } catch {
      // Table missing in this snapshot — try the next candidate.
    }
  }
  return 0;
}

/**
 * See the doc block above {@link countBackupTasks} for the full T5188/T11662
 * rationale. Exported (rather than module-private) ONLY so the T11662 concurrency
 * regression test can drive ≥4 racing invocations against a single `cleo.db` and
 * assert exactly one restore occurs under the shared first-open lock. Production
 * code MUST reach this solely via {@link getDb}.
 *
 * @param nativeDb - The freshly-opened consolidated handle (its `tasks_tasks` is
 *   probed for emptiness; closed before the file is overwritten on the restore path).
 * @param dbPath - Absolute path to the consolidated project `cleo.db`.
 * @param cwd - Working directory used to resolve the `.cleo/backups/sqlite/` dir.
 * @internal
 * @task T5188
 * @task T11662
 */
export async function autoRecoverFromBackup(
  nativeDb: DatabaseSync,
  dbPath: string,
  cwd: string | undefined,
): Promise<void> {
  // Lazy import openNativeDatabase at runtime to avoid any static-import
  // binding on sqlite-native.ts at module-init time.
  const { openNativeDatabase } = await import('./sqlite-native.js');
  const log = getLogger('sqlite');

  try {
    // Count tasks in current database.
    // T11578 · AC1: the runtime now reads the PREFIXED consolidated table, so the
    // emptiness probe targets `tasks_tasks` (the exodus-fill target) rather than
    // the now-dead bare `tasks` table.
    const countResult = nativeDb.prepare('SELECT COUNT(*) as cnt FROM tasks_tasks').get() as
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
      // T11578 · AC1: prefer the PREFIXED consolidated table (post-exodus
      // snapshots) and fall back to the bare `tasks` table for legacy
      // pre-consolidation backups so recovery still works across the cutover.
      backupTaskCount = countBackupTasks(backupDb);
    } finally {
      backupDb.close();
    }

    if (backupTaskCount < MIN_BACKUP_TASK_COUNT) {
      // Backup also has very few tasks — not a reliable recovery source
      return;
    }

    // ── Destructive restore under the shared first-open lock (T11662) ─────────
    // Everything above is a cheap, side-effect-free probe; from here we mutate
    // the live DB file + WAL. Serialise that against (a) any other concurrent
    // autoRecoverFromBackup invocation and (b) the exodus first-open migration,
    // BOTH of which contend on this exact lock for the same empty cleo.db.
    const lockPath = dbPath + FIRST_OPEN_LOCK_SUFFIX;
    await withLock(
      lockPath,
      async (): Promise<void> => {
        // Double-checked locking: while we were blocked acquiring the lock,
        // another process (a sibling auto-recovery OR the exodus migration) may
        // have already populated the DB. Re-query from a FRESH on-disk handle —
        // the caller's `nativeDb` may be stale and cannot see another process's
        // commits. If the data is now present, the restore is unnecessary →
        // return WITHOUT touching the WAL or DB file.
        const currentTaskCount = await recountTasksFromDisk(dbPath);
        if (currentTaskCount > 0) {
          log.info(
            { dbPath, currentTaskCount },
            'Auto-recovery skipped: database was populated by a concurrent process ' +
              'while acquiring the first-open lock (T11662 double-checked re-query).',
          );
          return;
        }

        // We are the lock winner over a still-empty DB AND have a backup with
        // data — perform the restore.
        log.warn(
          { dbPath, backupPath: newestBackup.path, backupTasks: backupTaskCount },
          `Empty database detected with ${backupTaskCount}-task backup available. ` +
            'Auto-recovering from backup. This likely happened because git-tracked ' +
            'WAL/SHM files were overwritten during a branch switch (T5188).',
        );

        // Close current connection
        if (nativeDb.isOpen) {
          nativeDb.close();
        }

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

        // Re-open the restored database — update the native singleton.
        // The dual-scope cache is now stale (its nativeDb was closed above);
        // reset it so the singleton is re-established on next getDb().
        _resetDualScopeDbCache();
        const restoredNativeDb = openNativeDatabase(dbPath);
        _nativeDb = restoredNativeDb;

        // Re-run migrations on restored DB to ensure schema is current
        const restoredDb = _getDrizzle()({ client: restoredNativeDb, schema });
        runMigrations(restoredNativeDb, restoredDb);

        // Update the singleton drizzle instance
        _db = restoredDb;
      },
      // Allow a generous stale window + retries: an exodus migration holding this
      // lock can take a while on a large fleet (matches on-open.ts), so a blocked
      // auto-recovery must wait rather than time out and race.
      { stale: 600_000, retries: 30 },
    );
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
  // getDb() callers that bypass openCleoDb('project', cwd).
  // Fires before any DB file is touched, matching the openCleoDb chokepoint.
  assertDbPathIsNotWorktreeResident('tasks', cwd);

  // Resolve the cleo.db path via the dual-scope helper (same logic as
  // openDualScopeDb uses internally) to drive the singleton key.
  const requestedPath = resolveDualScopeDbPath('project', cwd);

  // If singleton exists but points to different path, reset it
  if (_db && _dbPath !== requestedPath) {
    resetDbState();
  }

  // Liveness guard (T12020): the tasks domain shares the consolidated project
  // `cleo.db` `DatabaseSync` with the brain domain (both extract `$client` from
  // the same `openDualScopeDb('project')` cache entry). A concurrent or deferred
  // reset on the shared handle — e.g. another domain's `closeDb()` /
  // `_resetDualScopeDbCache('project')`, or a fire-and-forget brain write firing
  // across a test boundary — can close the underlying connection while THIS
  // singleton still references it. Returning that stale (closed) handle makes
  // the next query throw `database is not open`, which `observeBrain`'s cross-db
  // session write-guard swallows and mistakes for "session absent" — silently
  // nulling `sourceSessionId`. Detect the closed handle and re-derive from the
  // live `openDualScopeDb` cache below. Mirrors the brain-domain guard in
  // `getBrainDb` (memory-sqlite.ts, T11522).
  if (_db && (_nativeDb === null || !_nativeDb.isOpen)) {
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

  // Bootstrap baseline + reconcile stale journal entries.
  // T11829: the drizzle-tasks lineage runs against the SHARED consolidated cleo.db
  // journal — pass the OTHER lineages so their rows are not deleted as orphans.
  reconcileJournal(
    nativeDb,
    migrationsFolder,
    'tasks',
    'sqlite',
    resolveConsolidatedJournalSiblings('drizzle-tasks'),
  );

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
 *
 * ## E6-L1 (T11521)
 *
 * Resets the dual-scope cache via {@link _resetDualScopeDbCache} so the next
 * `getDb()` call re-initialises cleanly rather than receiving a stale cached
 * handle whose `DatabaseSync` is already closed (which would produce
 * "database is not open" errors in migration-manager).
 *
 * Without the cache eviction, `openDualScopeDb` would return the stale entry
 * for the same (scope, cwd) key — its `DatabaseSync` already closed by
 * `_nativeDb.close()` below — causing downstream "database is not open" errors
 * in `runMigrations → tableExists` for the very next `getDb()` caller.
 */
export function closeDb(): void {
  // Evict the PROJECT-scope dual-scope cache entries so the next openDualScopeDb()
  // call opens a fresh DatabaseSync. Without this, the cache would return the
  // stale handle whose nativeDb we're about to close below.
  //
  // E6-L4 (T11524): scope the eviction to `'project'`. The GLOBAL `cleo.db`
  // handle (nexus/signaldock/skills) now shares this same cache; an unscoped
  // reset here would close the global handle out from under an in-flight nexus
  // query (e.g. nexusSyncAll holding a handle while readProjectMeta opens + closes
  // a project accessor). Global teardown is the job of closeAllDatabases().
  _resetDualScopeDbCache('project');
  if (_nativeDb) {
    try {
      if (_nativeDb.isOpen) {
        _nativeDb.close();
      }
    } catch {
      // Ignore close errors — _resetDualScopeDbCache already closed it
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
 *
 * ## E6-L1 (T11521)
 *
 * Also resets the dual-scope cache via {@link _resetDualScopeDbCache} so the
 * next `getDb()` opens a fresh handle rather than reusing a stale one.
 * Mirrors the cache-eviction logic in {@link closeDb}.
 *
 * E6-L4 (T11524): scoped to `'project'` so it does not close the shared GLOBAL
 * `cleo.db` handle (nexus/signaldock/skills) — see {@link closeDb}.
 */
export function resetDbState(): void {
  _resetDualScopeDbCache('project');
  if (_nativeDb) {
    try {
      if (_nativeDb.isOpen) {
        _nativeDb.close();
      }
    } catch {
      // Ignore close errors — _resetDualScopeDbCache already closed it
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
 * ## E6-L1 (T11521)
 *
 * After the dual-scope migration, `getDb()` opens `cleo.db` via
 * {@link openDualScopeDb} — not the legacy `tasks.db`. This function now
 * checks for `cleo.db` so that callers (e.g. `migration-sqlite.ts`) correctly
 * detect the E6 database and skip re-migration.
 *
 * {@link getDbPath} still returns the legacy `tasks.db` path for backward-compat
 * callers that specifically need that file (e.g. backup path construction).
 */
export function dbExists(cwd?: string): boolean {
  return existsSync(resolveDualScopeDbPath('project', cwd));
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
