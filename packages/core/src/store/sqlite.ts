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
  type ProjectStore,
  resolveDualScopeDbPath,
} from './dual-scope-db.js';
import { rebuildLegacyTasksLineage } from './legacy-tasks-lineage.js';
import { withLock } from './lock.js';
import type { RequiredColumn } from './migration-manager.js';
import {
  createSafetyBackup,
  ensureColumns,
  isSqliteBusy,
  migrateWithRetry,
  reconcileJournal,
  tableExists,
} from './migration-manager.js';
// T12037: the tasks domain no longer owns a singleton — the path-keyed binding
// registry does. This module contributes only `establishTasksSchema`.
import {
  bindProjectDomain,
  boundProjectNative,
  type DomainBinding,
  releaseDomainBindings,
  resetCleoRuntime,
} from './ports/domain-binding.js';
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

// ── No singleton state (E6-L13 · T12037) ─────────────────────────────────────
// This module used to own `_db` / `_nativeDb` / `_dbPath` / `_initPromise`.
// All four are gone: caching, path keying, single-flight, and handle liveness
// belong to the path-keyed binding registry in `ports/domain-binding.ts`,
// layered on the CleoRuntime store registry (T12036). This module now owns
// only the tasks domain's schema reconciliation.

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
 * ## E6-L13 (T12037) — restore signals, it does not re-point
 *
 * Before the ProjectStore cutover this function re-opened the restored file
 * and re-pointed the module-global `_db` / `_nativeDb` singletons itself.
 * With those singletons gone it now performs ONLY the file-level restore and
 * returns `true`, and {@link bindTasksDomain} re-binds every project domain
 * against the restored file. That is strictly safer: the brain/conduit
 * bindings sharing the same `cleo.db` are invalidated too, where the old
 * singleton re-point left them holding a closed handle.
 *
 * @param nativeDb - The freshly-opened consolidated handle (its `tasks_tasks` is
 *   probed for emptiness; closed before the file is overwritten on the restore path).
 * @param dbPath - Absolute path to the consolidated project `cleo.db`.
 * @param cwd - Working directory used to resolve the `.cleo/backups/sqlite/` dir.
 * @returns `true` when the DB file was replaced from a backup (callers MUST
 *   re-bind); `false` when no recovery was needed or possible.
 * @internal
 * @task T5188
 * @task T11662
 * @task T12037
 */
export async function autoRecoverFromBackup(
  nativeDb: DatabaseSync,
  dbPath: string,
  cwd: string | undefined,
): Promise<boolean> {
  // Lazy import openNativeDatabase at runtime to avoid any static-import
  // binding on sqlite-native.ts at module-init time.
  const { openNativeDatabase } = await import('./sqlite-native.js');
  const log = getLogger('sqlite');
  let restored = false;

  try {
    // Count tasks in current database.
    // T11578 · AC1: the runtime now reads the PREFIXED consolidated table, so the
    // emptiness probe targets `tasks_tasks` (the exodus-fill target) rather than
    // the now-dead bare `tasks` table.
    const countResult = nativeDb.prepare('SELECT COUNT(*) as cnt FROM tasks_tasks').get() as
      | { cnt: number }
      | undefined;
    const taskCount = countResult?.cnt ?? 0;

    if (taskCount > 0) return false; // Database has data, no recovery needed

    // Database is empty — check for backups
    const backups = listSqliteBackups(cwd);
    if (backups.length === 0) {
      // No backups available — this is a genuinely new database
      return false;
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
      return false;
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

        // The dual-scope cache is now stale — its `DatabaseSync` was closed
        // above and the file underneath it has been replaced. Evict it so the
        // caller's re-bind opens a fresh connection to the restored file and
        // re-runs migrations through the normal chokepoint path (T12037).
        _resetDualScopeDbCache();
        restored = true;
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
  return restored;
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
export async function getDb(cwd?: string): Promise<NodeSQLiteDatabase> {
  return (await bindTasksDomain(cwd)).db;
}

/**
 * Bind the legacy tasks-schema to the {@link ProjectStore} for `cwd` and
 * return the full binding (store + native handle + typed Drizzle instance).
 *
 * ## E6-L13 cutover (T12037)
 *
 * This is the ProjectStore-bound typed port that replaces the module-global
 * singleton quartet (`_db` / `_nativeDb` / `_dbPath` / `_initPromise`) this
 * facade used to own. Caching, path keying, single-flight, and handle
 * liveness are now owned by {@link bindProjectDomain}; this function owns
 * only the tasks domain's schema reconciliation.
 *
 * Three defect classes disappear with the singleton:
 *
 * - **Last-project-wins** — `_dbPath` tracked ONE project, so alternating
 *   between two projects reset and re-migrated on every switch. Bindings are
 *   now keyed by canonical `cleo.db` path.
 * - **Cross-domain staleness** (T12019 / T12020) — the tasks singleton could
 *   hold a `DatabaseSync` the brain domain had already closed. A binding is
 *   valid only while the store instance it was established against is still
 *   the live one, so an eviction invalidates it by identity.
 * - **Band-aid reacquisition** (T12035) — the bounded retry loop that papered
 *   over the above is deleted; the runtime registry handles liveness.
 *
 * Prefer this over {@link getDb} when you also need the native handle or an
 * explicit store for a cross-domain transaction.
 *
 * @param cwd - Project working directory.
 * @returns The live tasks-domain binding.
 *
 * @task T12037 (E6-L13)
 */
export async function bindTasksDomain(
  cwd?: string,
): Promise<DomainBinding<NodeSQLiteDatabase, ProjectStore>> {
  // T9961 / T9806: worktree-isolation guard — defense-in-depth for direct
  // callers that bypass openCleoDb('project', cwd). Fires before any DB file
  // is touched, matching the openCleoDb chokepoint.
  assertDbPathIsNotWorktreeResident('tasks', cwd);

  // `establish` runs ONLY on a cold bind (first open, or after an eviction).
  // Capturing that here keeps auto-recovery a first-open concern: on a warm
  // cache hit we must not re-probe `tasks_tasks` and re-scan the backup
  // directory, which `getDb` does hundreds of times per process.
  let coldBind = false;
  const binding = await bindProjectDomain('tasks', cwd, (nativeDb, store) => {
    coldBind = true;
    return establishTasksSchema(nativeDb, store);
  });

  if (!coldBind) return binding;

  // ── T5188 auto-recovery (runs OUTSIDE establish) ──────────────────────────
  // Recovery may REPLACE the `cleo.db` file, which invalidates every domain
  // bound to it — not just this one. Running it here (rather than inside
  // `establish`) lets us drop all project-domain bindings for the path and
  // re-bind through the normal chokepoint, so brain/conduit never keep a
  // handle to the pre-restore file. The re-bind cannot recurse: the restored
  // DB is non-empty, so the emptiness probe short-circuits.
  if (await autoRecoverFromBackup(binding.native, binding.store.dbPath, cwd)) {
    releaseDomainBindings({ scope: 'project', dbPath: binding.store.dbPath });
    return bindProjectDomain('tasks', cwd, establishTasksSchema);
  }

  return binding;
}

/**
 * Reconcile the legacy tasks-domain schema against a consolidated `cleo.db`
 * native handle and return the tasks-typed Drizzle instance.
 *
 * Idempotent by contract — {@link bindProjectDomain} re-runs it whenever the
 * underlying store is evicted and re-opened.
 *
 * @param nativeDb - The shared consolidated connection.
 * @param store - The {@link ProjectStore} that owns `nativeDb`.
 * @returns The tasks-schema Drizzle handle.
 *
 * @task T12037 (E6-L13)
 */
function establishTasksSchema(nativeDb: DatabaseSync, store: ProjectStore): NodeSQLiteDatabase {
  // Wrap the shared native handle with the legacy tasks-schema drizzle
  // instance so all existing callers (schema.tasks, schema.sessions, …)
  // query the consolidated cleo.db unchanged.
  const db = _getDrizzle()({ client: nativeDb });

  // Run legacy drizzle-tasks migrations against the shared cleo.db handle.
  // During the E3→E6 transition these create the old `tasks` table family
  // alongside the consolidated `tasks_tasks` tables.
  runMigrations(nativeDb, db, store.dbPath);

  // Migration SQL contains PRAGMA foreign_keys=ON statements. In test
  // environments, disable FKs after migration so fixtures can insert
  // without full referential integrity.
  if (process.env.VITEST) {
    nativeDb.exec('PRAGMA foreign_keys=OFF');
  }

  seedTasksMeta(nativeDb);

  return db;
}

/**
 * The `task_id_sequence` value a fresh store is seeded with. The sequence module
 * treats it as "no state" (`isSeedSequence`), so a real counter — e.g. one a
 * legacy store carries — must always win over it.
 */
export const TASK_ID_SEQUENCE_SEED = '{"counter":0,"lastId":"T000","checksum":"seed"}';

/**
 * Seed the tasks domain's `schema_meta` defaults (no-op for keys already set).
 *
 * @param nativeDb - Connection on the project `cleo.db`.
 */
export function seedTasksMeta(nativeDb: DatabaseSync): void {
  nativeDb.exec(
    `INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('schemaVersion', '${SCHEMA_VERSION}')`,
  );
  nativeDb
    .prepare("INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('task_id_sequence', ?)")
    .run(TASK_ID_SEQUENCE_SEED);
}

/**
 * Create the tables the tasks-domain RUNTIME binds on a project `cleo.db`
 * without binding the domain: run the `drizzle-tasks` lineage (including the
 * T12346 rebuild when it cannot be replayed) on the given connection.
 *
 * Exodus (on-open and reconcile) copies legacy rows into the tables the runtime
 * reads — several of which (`audit_log`, `token_usage`, …) only this lineage
 * creates — so they must exist before the copy. It runs on the migration's own
 * dedicated connection: binding the domain from inside an open would wait on
 * that very open. Defaults are NOT seeded here; the caller seeds after the copy
 * ({@link seedTasksMeta}) so a legacy value is never shadowed by a default.
 *
 * @param nativeDb - Idle dedicated connection on the project `cleo.db`.
 * @param dbPath - Absolute path of that database.
 * @task T12355
 */
export function ensureTasksDomainTables(nativeDb: DatabaseSync, dbPath: string): void {
  runMigrations(nativeDb, _getDrizzle()({ client: nativeDb }), dbPath);
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
function runMigrations(nativeDb: DatabaseSync, db: NodeSQLiteDatabase, dbPath: string): void {
  const migrationsFolder = resolveMigrationsFolder();

  // Safety backup before any migration work. `dbPath` is passed explicitly
  // (T12037) — it used to be read from the module-global `_dbPath`, which was
  // `null` on the auto-recovery re-migrate path and silently skipped the
  // backup there.
  if (tableExists(nativeDb, 'tasks')) {
    createSafetyBackup(dbPath);
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
  try {
    migrateWithRetry(db, migrationsFolder, nativeDb, 'tasks', 'sqlite');
  } catch (error) {
    // T12346: a consolidated cleo.db whose bare legacy family was copied from a
    // high-water-era tasks.db cannot be replayed into shape. Rebuild that family
    // fresh (snapshot first, atomic, prefixed tables untouched); if even that
    // fails, the database is unchanged and the ORIGINAL error surfaces.
    if (isSqliteBusy(error) || !tableExists(nativeDb, 'tasks_tasks')) throw error;
    try {
      rebuildLegacyTasksLineage(
        nativeDb,
        dbPath,
        migrationsFolder,
        resolveConsolidatedJournalSiblings('drizzle-tasks'),
      );
    } catch (rebuildError) {
      getLogger('sqlite').error(
        { rebuildError },
        'legacy drizzle-tasks rebuild failed and was rolled back (T12346)',
      );
      throw error;
    }
  }

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
  // Evict the PROJECT-scope dual-scope cache entries so the next bind opens a
  // fresh DatabaseSync.
  //
  // E6-L4 (T11524): scope the eviction to `'project'`. The GLOBAL `cleo.db`
  // handle (nexus/signaldock/skills) now shares this same cache; an unscoped
  // reset here would close the global handle out from under an in-flight nexus
  // query (e.g. nexusSyncAll holding a handle while readProjectMeta opens + closes
  // a project accessor). Global teardown is the job of closeAllDatabases().
  //
  // E6-L13 (T12037): with the module-global singletons gone there is no
  // private handle left to close here — the connection belongs to the
  // dual-scope chokepoint, which `_resetDualScopeDbCache` closes. Dropping
  // the project-domain bindings forces the next bind to re-establish the
  // schema against whatever handle the chokepoint hands back.
  _resetDualScopeDbCache('project');
  releaseDomainBindings({ scope: 'project' });
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
  releaseDomainBindings({ scope: 'project' });
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
 * Get the underlying `node:sqlite` `DatabaseSync` for the tasks domain.
 * Useful for direct PRAGMA calls or raw SQL operations.
 *
 * ## E6-L13 (T12037) — now path-keyed
 *
 * This used to return a module-global that tracked whichever project was
 * opened LAST. It now resolves the binding for `cwd`, so two projects live in
 * one process without clobbering each other. Returns `null` when the tasks
 * domain has not been bound for that project yet (or its connection has since
 * closed) — callers must `await` {@link getDb} / {@link bindTasksDomain} first,
 * which every existing call site already does.
 *
 * @param cwd - Project working directory. Defaults to the ambient project.
 *
 * @deprecated Read `.native` from {@link bindTasksDomain} instead — it cannot
 *   return `null` and needs no prior await. Removed in T12040 (E6-L16).
 */
export function getNativeDb(cwd?: string): DatabaseSync | null {
  return boundProjectNative('tasks', cwd);
}

/**
 * Get the underlying `node:sqlite` `DatabaseSync` for the tasks domain.
 *
 * Thin alias of {@link getNativeDb} retained for call-site clarity in code
 * that predates the consolidated `cleo.db`.
 *
 * @param cwd - Project working directory. Defaults to the ambient project.
 *
 * @deprecated See {@link getNativeDb}.
 */
export function getNativeTasksDb(cwd?: string): DatabaseSync | null {
  return boundProjectNative('tasks', cwd);
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

  // E6-L16 (T12040): the per-domain closers above drop bindings but each is
  // scoped to its own domain (and `closeDb` only to the project scope). Full
  // teardown means the runtime registry too — every project entry AND the
  // global entry — otherwise a Windows temp-dir removal fails on a global
  // `cleo.db` handle no domain closer owns. This is the ONLY caller that may
  // tear down the whole runtime.
  resetCleoRuntime();
}
