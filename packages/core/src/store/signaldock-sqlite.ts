/**
 * SQLite store for global-tier signaldock.db — canonical agent identity database.
 *
 * Post-T310 (ADR-037), signaldock.db lives at `$XDG_DATA_HOME/cleo/signaldock.db`
 * (resolved via getCleoHome()). It holds cross-project agent identity, capabilities
 * catalog, and cloud-sync tables. Project-local messaging state has moved to
 * conduit.db (managed by conduit-sqlite.ts, T344).
 *
 * ## E6-L5 — thin-facade migration (T11525)
 *
 * `ensureGlobalSignaldockDb()` is now a thin facade that delegates the database
 * open to {@link openDualScopeDb}('global') — the canonical dual-scope chokepoint
 * (E3/E4 · T11512/T11517) already adopted by the tasks domain (E6-L1, T11521),
 * the brain domain (E6-L2, T11522), the conduit domain (E6-L3, T11523), and the
 * nexus domain (E6-L4, T11524). The signaldock tables now live inside the
 * consolidated GLOBAL `cleo.db` under {@link getCleoHome}, sharing the SAME native
 * handle the nexus / skills global domains use.
 *
 * The legacy `drizzle-signaldock` migrations are still applied to this handle.
 * They create the runtime-queried physical tables under BARE names (`agents`,
 * `capabilities`, `skills`, `agent_capabilities`, …). The consolidated GLOBAL
 * schema (`drizzle-cleo-global`) carries the `signaldock_` domain prefix
 * (`signaldock_agents`, `signaldock_skills`, …). These are DIFFERENT physical
 * names, so the legacy and consolidated tables CO-EXIST harmlessly in the same
 * `cleo.db` — exactly like the conduit domain (`conversations` ≠
 * `conduit_conversations`) and the tasks domain (`tasks` ≠ `tasks_tasks`).
 *
 * NB: signaldock's legacy `skills` catalog (slug → id, queried via raw SQL in
 * agent-registry-accessor / agent-install / agent-doctor) keeps its BARE name,
 * while the skills-db registry domain (E6-L5 sibling) lands on the prefixed
 * `skills_skills` consolidated table — so the two former-separate-file domains no
 * longer collide on a bare `skills` name now that they share one `cleo.db`.
 *
 * The residency MOVE of signaldock global→project and the exodus data copy are
 * SEPARATE later tasks (T11553 / T11538). This task keeps the ADR-037 global-only
 * invariant intact.
 *
 * Migration folder: packages/core/migrations/drizzle-signaldock/
 *
 * GLOBAL-TIER ONLY. This module MUST NOT resolve paths under any project's .cleo/
 * directory. The path guard in getGlobalSignaldockDbPath() enforces this invariant.
 *
 * @task T346
 * @task T1166
 * @task T11525 - E6-L5: route ensureGlobalSignaldockDb through openDualScopeDb('global') (SG-DB-SUBSTRATE-V2)
 * @epic T310
 * @epic T1150
 * @epic T11249
 * @related ADR-037
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { getCleoHome } from '../paths.js';
// E6-L5 (T11525): dual-scope chokepoint — the signaldock domain now opens the
// consolidated GLOBAL `cleo.db` through here. openDualScopeDb manages the
// DatabaseSync lifecycle, pragmas, and consolidated migrations. We extract the
// native handle and run the legacy drizzle-signaldock migrations on it so
// existing callers (raw-SQL agent registry access) compile and run unchanged.
import { _resetDualScopeDbCache, openDualScopeDb } from './dual-scope-db.js';
import { migrateSanitized, reconcileJournal } from './migration-manager.js';
import { resolveCorePackageMigrationsFolder } from './resolve-migrations-folder.js';
import * as signaldockSchema from './schema/signaldock-schema.js';

/**
 * Database file name within the global cleo home directory.
 *
 * @task T346
 * @epic T310
 */
export const GLOBAL_SIGNALDOCK_DB_FILENAME = 'signaldock.db';

/**
 * Schema version for global signaldock databases.
 *
 * @task T346
 * @epic T310
 */
export const GLOBAL_SIGNALDOCK_SCHEMA_VERSION = '2026.4.12';

/**
 * @deprecated Use GLOBAL_SIGNALDOCK_SCHEMA_VERSION. T310 is done (archived).
 * Retained only because packages/core/src/internal.ts re-exports this name.
 * Removal blocked until internal.ts export is cleaned up.
 * Tracking: T355 / T1508 P2-NEW-2 — remove in v2026.5.0.
 */
export const SIGNALDOCK_SCHEMA_VERSION = GLOBAL_SIGNALDOCK_SCHEMA_VERSION;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Returns the GLOBAL-tier signaldock DB path — the consolidated GLOBAL `cleo.db`.
 *
 * E6-L5 (T11525): resolves `getCleoHome()` + `cleo.db` (the same path
 * {@link openDualScopeDb}('global') opens). signaldock holds canonical agent
 * identity + cloud-sync tables and stays GLOBAL — its tables live inside the
 * consolidated GLOBAL `cleo.db`, NOT a separate `signaldock.db` file. Project-local
 * messaging state lives in conduit.db (T344).
 *
 * Guard: asserts the resolved path starts with getCleoHome() (defense in depth,
 * mirrors the ADR-036/037 pattern used by getNexusDbPath in nexus-sqlite.ts).
 *
 * @task T346
 * @task T11525
 * @epic T310
 * @epic T11249
 * @why ADR-037 split single signaldock.db into project conduit + global signaldock
 * @throws {Error} If resolved path is not under getCleoHome() — indicates a code
 *   path that bypasses canonical path resolution. Fix the caller, do not suppress.
 */
export function getGlobalSignaldockDbPath(): string {
  // Resolve via THIS module's getCleoHome binding so the path and the guard are
  // self-consistent. (The dual-scope resolver builds the identical path —
  // join(getCleoHome(), 'cleo.db') — but binds getCleoHome through its own module
  // graph, which can diverge under per-test vi.doMock timing. Building locally and
  // asserting against the SAME binding keeps the defense-in-depth guard correct
  // without spuriously firing when a test mocks getCleoHome. T11525.)
  const cleoHome = getCleoHome();
  const dbPath = join(cleoHome, 'cleo.db');
  if (!dbPath.startsWith(cleoHome)) {
    /* c8 ignore next 7 — unreachable: dbPath is built FROM cleoHome above. */
    throw new Error(
      `BUG: getGlobalSignaldockDbPath() resolved to "${dbPath}" which is NOT under ` +
        `getCleoHome() ("${cleoHome}"). signaldock is global-only per ADR-037. ` +
        `This indicates a code path that bypasses path resolution — ` +
        `fix the caller, do not suppress this error.`,
    );
  }
  return dbPath;
}

/**
 * @deprecated Use getGlobalSignaldockDbPath() directly. T310 is done (archived).
 * Blocked from deletion: two callers still use this shim and require migration:
 *   - packages/core/src/store/cross-db-cleanup.ts (calls with cwd — will throw)
 *   - packages/core/src/internal.ts (re-exports this name)
 * Fix: migrate cross-db-cleanup.ts to use getConduitDbPath() and remove from
 * internal.ts. Tracking: T355 / T1508 P2-NEW-2 — remove in v2026.5.0.
 *
 * When called WITHOUT arguments: returns the global-tier path (forwards to
 * getGlobalSignaldockDbPath()).
 *
 * When called WITH a non-undefined `cwd` argument: throws a migration error
 * immediately. The project-tier path is now owned by conduit-sqlite.ts (T344).
 *
 * @param cwd - Must be undefined. Any other value throws a migration error.
 * @task T346
 * @epic T310
 */
export function getSignaldockDbPath(cwd?: string): string {
  if (cwd !== undefined) {
    throw new Error(
      'getSignaldockDbPath(cwd) is removed as of T310 (v2026.4.12). ' +
        'signaldock.db is now global-only at $XDG_DATA_HOME/cleo/signaldock.db. ' +
        'Use getGlobalSignaldockDbPath(), or for project-local messaging use ' +
        'getConduitDbPath() from conduit-sqlite.ts (T344).',
    );
  }
  return getGlobalSignaldockDbPath();
}

// ---------------------------------------------------------------------------
// Migration folder resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to the drizzle-signaldock migrations folder inside
 * @cleocode/core, using ESM-native module resolution (T1177).
 *
 * Delegates to {@link resolveCorePackageMigrationsFolder} which handles
 * bundled dist/, workspace dev, and global-install layouts uniformly via
 * `import.meta.resolve()` + `createRequire().resolve()` fallback.
 *
 * @task T1166
 * @epic T1150
 */
export function resolveSignaldockMigrationsFolder(): string {
  return resolveCorePackageMigrationsFolder('drizzle-signaldock');
}

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

/**
 * Run drizzle migrations to create/update signaldock.db tables.
 *
 * Uses reconcileJournal + migrateSanitized for backwards compatibility with
 * existing signaldock.db files in the wild. The reconciler's Scenario 1 and
 * Scenario 3 probe-and-mark-applied logic detects when the schema already
 * matches (e.g., an existing DB that had the T897 migration applied via the
 * old bare-SQL runner) and inserts journal rows without re-running DDL.
 *
 * Replaces the former applyGlobalSignaldockSchema() / GLOBAL_EMBEDDED_MIGRATIONS
 * bare-SQL runner (T1166 / T1150 Wave 2A-04).
 *
 * @param nativeDb - An open DatabaseSync handle at the global signaldock path
 * @task T1166
 * @epic T1150
 */
function runSignaldockMigrations(nativeDb: DatabaseSync): void {
  const migrationsFolder = resolveSignaldockMigrationsFolder();

  // Reconcile the Drizzle journal before running migrations.
  // Handles:
  //   Scenario 1: agents table exists but __drizzle_migrations does not
  //               → bootstrap the baseline as applied
  //   Scenario 3: column exists but journal entry absent
  //               → insert missing journal entry to avoid duplicate-column errors
  //   Scenario 4: null name in journal entries
  //               → backfill names so Drizzle v1 beta can detect applied migrations
  reconcileJournal(nativeDb, migrationsFolder, 'agents', 'signaldock');

  // Create the drizzle ORM wrapper and run pending migrations.
  const db = drizzle({ client: nativeDb, schema: signaldockSchema });
  migrateSanitized(db, { migrationsFolder });
}

// ---------------------------------------------------------------------------
// Database lifecycle
// ---------------------------------------------------------------------------

/**
 * Singleton native DatabaseSync handle for the current process.
 *
 * E6-L5 (T11525): this is the SHARED consolidated GLOBAL `cleo.db` handle owned
 * by {@link openDualScopeDb}('global') and co-owned by the nexus / skills global
 * domains. signaldock MUST NOT close it directly (see
 * {@link _resetGlobalSignaldockDb_TESTING_ONLY}).
 */
let _globalSignaldockNativeDb: DatabaseSync | null = null;

/**
 * Ensure global signaldock.db exists with the full global schema applied.
 * Creates the global cleo home directory if it doesn't exist.
 * Idempotent — safe to call multiple times.
 *
 * @returns Object with action ('created' | 'exists') and the database path
 * @task T346
 * @task T1166
 * @epic T310
 */
/**
 * Read the `schema_version` row from `_signaldock_meta` if it exists.
 *
 * Used by {@link ensureGlobalSignaldockDb} as a fast-path sentinel: when the
 * value matches {@link GLOBAL_SIGNALDOCK_SCHEMA_VERSION} we know the DB is
 * fully bootstrapped and migrated to the in-process code version, so we can
 * skip the {@link runSignaldockMigrations} pipeline (reconcileJournal +
 * migrateSanitized) on every CLI invocation (T9027 — epic T9026, CLI startup
 * tax reduction).
 *
 * Defensive: returns `null` if the meta table is missing (very old / partially
 * initialized DBs) or the row is absent. Any throw is swallowed — a sentinel
 * miss simply forces the fall-through migration replay path which is safe.
 *
 * @param db - An open signaldock.db handle.
 * @returns The schema_version string, or `null` if absent / unreadable.
 * @task T9027
 * @epic T9026
 */
function readSignaldockSchemaVersionSentinel(db: DatabaseSync): string | null {
  try {
    const row = db
      .prepare("SELECT value FROM _signaldock_meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * Write the in-process schema version into `_signaldock_meta`.
 *
 * Creates the meta table if missing (older signaldock.db files predate any
 * meta-table guarantee) and stamps the current version so the next process
 * can short-circuit via {@link readSignaldockSchemaVersionSentinel}.
 *
 * @param db - An open signaldock.db handle (post-migration).
 * @task T9027
 * @epic T9026
 */
function writeSignaldockSchemaVersionSentinel(db: DatabaseSync): void {
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS _signaldock_meta (
         key TEXT PRIMARY KEY,
         value TEXT NOT NULL,
         updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
       );
       INSERT OR REPLACE INTO _signaldock_meta (key, value, updated_at)
       VALUES ('schema_version', '${GLOBAL_SIGNALDOCK_SCHEMA_VERSION}', strftime('%s', 'now'));`,
    );
  } catch {
    // Non-fatal: if the meta write fails, ensure() still succeeds. Next
    // invocation will simply take the fall-through path (sentinel miss).
  }
}

export async function ensureGlobalSignaldockDb(): Promise<{
  action: 'created' | 'exists';
  path: string;
}> {
  const dbPath = getGlobalSignaldockDbPath();
  const alreadyExists = existsSync(dbPath);

  // ── Dual-scope chokepoint delegation (T11525 · E6-L5) ────────────────────
  // openDualScopeDb('global') applies the pragma SSoT, creates the directory,
  // runs the consolidated cleo-global migrations (which create the prefixed
  // `signaldock_*` tables), and manages the singleton cache. We extract its
  // native handle so we can run the legacy `drizzle-signaldock` migrations,
  // which create the BARE-named runtime tables (`agents`, `capabilities`,
  // `skills`, …) the raw-SQL agent-registry callers query. The bare and
  // prefixed tables DIFFER, so they co-exist in the same `cleo.db`.
  const dualHandle = await openDualScopeDb('global');

  // Extract the underlying DatabaseSync. Drizzle exposes it via `$client`.
  const nativeDb = (dualHandle.db as { $client?: DatabaseSync }).$client ?? null;
  if (!nativeDb) {
    throw new Error(
      'E6-L5: openDualScopeDb returned a handle without $client — ' +
        'cannot extract DatabaseSync for legacy signaldock-schema migration.',
    );
  }

  // Check if the legacy signaldock schema is already applied (agents table
  // as sentinel — the bare runtime table, NOT the prefixed `signaldock_agents`).
  const hasSchema = (() => {
    try {
      const result = nativeDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agents'")
        .get() as { name: string } | undefined;
      return !!result;
    } catch {
      return false;
    }
  })();

  // T9027 — Schema-version sentinel fast path (epic T9026, CLI startup tax).
  //
  // If the legacy signaldock schema is already applied AND its
  // `_signaldock_meta.schema_version` row exactly equals the in-process
  // `GLOBAL_SIGNALDOCK_SCHEMA_VERSION` constant, we can skip
  // `runSignaldockMigrations()` entirely. That function performs a
  // reconcileJournal() + migrateSanitized() pass that, while a no-op for an
  // up-to-date DB, still pays a non-trivial cost on every CLI invocation
  // (journal SELECT, regex sanitization, drizzle migrator probe).
  //
  // Fall-through (sentinel missing, stale, or mismatched) preserves the
  // full migration replay path so fresh DBs and version bumps still work.
  if (
    hasSchema &&
    readSignaldockSchemaVersionSentinel(nativeDb) === GLOBAL_SIGNALDOCK_SCHEMA_VERSION
  ) {
    _globalSignaldockNativeDb = nativeDb;
    return { action: 'exists', path: dbPath };
  }

  // Run the legacy `drizzle-signaldock` migrations (reconcileJournal +
  // migrateSanitized) on the shared handle. Their `__drizzle_migrations`
  // journal is shared with the cleo-global journal in the same `cleo.db`; the
  // hashes are disjoint so the signaldock migrations are reconciled/applied
  // independently. For existing DBs that used the old bare-SQL runner,
  // reconcileJournal Scenario 1 bootstraps the journal from the existing
  // `agents` table, and Scenario 3 marks T897 ALTER columns as applied.
  runSignaldockMigrations(nativeDb);

  // Stamp schema_version sentinel so the next process can take the fast path.
  writeSignaldockSchemaVersionSentinel(nativeDb);

  // Store native handle for backup integration (getGlobalSignaldockNativeDb).
  _globalSignaldockNativeDb = nativeDb;

  return {
    action: alreadyExists && hasSchema ? 'exists' : 'created',
    path: dbPath,
  };
  // NOTE: We intentionally do NOT close the native handle — it is the SHARED
  // dual-scope GLOBAL `cleo.db` handle (E6-L5), co-owned by the nexus / skills
  // global domains. Its lifecycle is owned by `openDualScopeDb`; tearing it down
  // here would break in-flight sibling queries. On error we also do NOT close it
  // for the same reason — `openDualScopeDb`'s own init guard handles open
  // failures.
}

/**
 * @deprecated Use ensureGlobalSignaldockDb(). T310 is done (archived).
 * Blocked from deletion: caller still uses this shim and requires migration:
 *   - packages/core/src/upgrade.ts calls ensureSignaldockDb(projectRootForMaint)
 *     (with cwd arg — will throw at runtime). Must migrate to ensureConduitDb(cwd).
 *   - packages/core/src/internal.ts re-exports this name.
 * Tracking: T355 / T1508 P2-NEW-2 — remove in v2026.5.0.
 *
 * When called WITHOUT arguments: forwards to ensureGlobalSignaldockDb().
 * When called WITH a non-undefined `cwd` argument: throws a migration error.
 *
 * @param cwd - Must be undefined. Any other value throws a migration error.
 * @task T346
 * @epic T310
 */
export async function ensureSignaldockDb(
  cwd?: string,
): Promise<{ action: 'created' | 'exists'; path: string }> {
  if (cwd !== undefined) {
    throw new Error(
      'ensureSignaldockDb(cwd) is removed as of T310 (v2026.4.12). ' +
        'signaldock.db is now global-only. ' +
        'Use ensureGlobalSignaldockDb() for global identity, or ' +
        'ensureConduitDb(cwd) from conduit-sqlite.ts for project messaging (T344).',
    );
  }
  return ensureGlobalSignaldockDb();
}

/**
 * Check global signaldock health: table count, WAL mode, schema version.
 * Used by `cleo doctor` to verify global signaldock integrity.
 *
 * E6-L5 (T11525): reads against the SHARED consolidated GLOBAL `cleo.db` handle
 * (via {@link ensureGlobalSignaldockDb}, which routes through
 * {@link openDualScopeDb}('global')) rather than opening a separate read-only
 * `signaldock.db` handle. The metrics describe the consolidated `cleo.db` that
 * now hosts the legacy signaldock tables.
 *
 * @returns Health report object, or object with exists=false if the DB does not exist.
 * @task T346
 * @task T11525
 * @epic T310
 * @epic T11249
 */
export async function checkGlobalSignaldockDbHealth(): Promise<{
  exists: boolean;
  path: string;
  tableCount: number;
  walMode: boolean;
  schemaVersion: string | null;
  foreignKeysEnabled: boolean;
} | null> {
  const dbPath = getGlobalSignaldockDbPath();
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

  // Route through the dual-scope chokepoint to obtain the shared, fully-migrated
  // consolidated `cleo.db` handle. ensureGlobalSignaldockDb() is idempotent and
  // stores the handle in _globalSignaldockNativeDb.
  await ensureGlobalSignaldockDb();
  const nativeDb = _globalSignaldockNativeDb;
  if (!nativeDb) {
    /* c8 ignore next */
    return {
      exists: false,
      path: dbPath,
      tableCount: 0,
      walMode: false,
      schemaVersion: null,
      foreignKeysEnabled: false,
    };
  }

  const tables = nativeDb
    .prepare(
      "SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .get() as { count: number };

  const journalMode = nativeDb.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
  const fkEnabled = nativeDb.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };

  // Schema version: check the __drizzle_migrations journal for evidence of
  // migrations applied. Fallback to _signaldock_meta for pre-T1166 DBs.
  let schemaVersion: string | null = null;
  try {
    // Post-T1166 path: check if drizzle journal has entries
    const journalRow = nativeDb
      .prepare('SELECT COUNT(*) as cnt FROM "__drizzle_migrations"')
      .get() as { cnt: number } | undefined;
    if (journalRow && journalRow.cnt > 0) {
      schemaVersion = GLOBAL_SIGNALDOCK_SCHEMA_VERSION;
    }
  } catch {
    // __drizzle_migrations does not exist yet — fall through to _signaldock_meta
  }

  if (!schemaVersion) {
    try {
      // Pre-T1166 path: _signaldock_meta table (old bare-SQL runner)
      const meta = nativeDb
        .prepare("SELECT value FROM _signaldock_meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined;
      schemaVersion = meta?.value ?? null;
    } catch {
      // _signaldock_meta may not exist on very old or partially-initialized DBs
    }
  }

  return {
    exists: true,
    path: dbPath,
    tableCount: tables.count,
    walMode: journalMode.journal_mode === 'wal',
    schemaVersion,
    foreignKeysEnabled: fkEnabled.foreign_keys === 1,
  };
}

/**
 * @deprecated Use checkGlobalSignaldockDbHealth(). T310 is done (archived).
 * Retained only because packages/core/src/internal.ts re-exports this name.
 * Removal blocked until internal.ts export is cleaned up.
 * Tracking: T355 / T1508 P2-NEW-2 — remove in v2026.5.0.
 *
 * When called WITHOUT arguments: forwards to checkGlobalSignaldockDbHealth().
 * When called WITH a non-undefined `cwd` argument: throws a migration error.
 *
 * @param cwd - Must be undefined. Any other value throws a migration error.
 * @task T346
 * @epic T310
 */
export async function checkSignaldockDbHealth(cwd?: string): Promise<{
  exists: boolean;
  path: string;
  tableCount: number;
  walMode: boolean;
  schemaVersion: string | null;
  foreignKeysEnabled: boolean;
} | null> {
  if (cwd !== undefined) {
    throw new Error(
      'checkSignaldockDbHealth(cwd) is removed as of T310 (v2026.4.12). ' +
        'signaldock.db is now global-only. ' +
        'Use checkGlobalSignaldockDbHealth() for global signaldock health, or ' +
        'checkConduitDbHealth(cwd) from conduit-sqlite.ts for project conduit health (T344).',
    );
  }
  return checkGlobalSignaldockDbHealth();
}

/**
 * Get the underlying node:sqlite DatabaseSync instance for global signaldock.db.
 * Returns the handle stored by the most recent ensureGlobalSignaldockDb() call,
 * or null if the database has not yet been initialized in this process.
 *
 * Used by sqlite-backup.ts to activate the signaldock GLOBAL_SNAPSHOT_TARGET
 * (spec §6.2, T310).
 *
 * @task T346
 * @epic T310
 */
export function getGlobalSignaldockNativeDb(): DatabaseSync | null {
  return _globalSignaldockNativeDb;
}

/**
 * Reset the in-process global signaldock singleton.
 * ONLY for use in test isolation — never call in production code.
 *
 * ## E6-L5 (T11525) — shared-handle close rule
 *
 * `_globalSignaldockNativeDb` is the SHARED consolidated GLOBAL `cleo.db` handle
 * owned by {@link openDualScopeDb}('global') and co-owned by the nexus / skills
 * global domains. This reset MUST NOT call `.close()` on it directly — doing so
 * would tear the handle out from under nexus / skills (the exact bug class L4
 * fixed at `dual-scope-db.ts`). Instead it evicts the GLOBAL-scope entry from the
 * dual-scope cache (which closes the underlying handle exactly once and only when
 * no scope filter excludes it) and drops the local reference. The next
 * `ensureGlobalSignaldockDb()` re-opens a fresh consolidated handle.
 *
 * @task T346
 * @task T11525
 * @epic T310
 * @epic T11249
 */
export function _resetGlobalSignaldockDb_TESTING_ONLY(): void {
  // Drop only the local reference. The scope-filtered cache reset performs the
  // single coordinated close of the shared GLOBAL handle.
  _globalSignaldockNativeDb = null;
  _resetDualScopeDbCache('global');
}
