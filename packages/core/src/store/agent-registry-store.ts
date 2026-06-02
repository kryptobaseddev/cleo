/**
 * SQLite store for the GLOBAL-tier **Agent Registry** — the canonical agent
 * identity database (agents / capabilities / skills / credentials). Formerly
 * labelled "signaldock"; renamed under T11622 / SG-AGENT-IDENTITY E4.
 *
 * The Agent Registry holds cross-project agent identity, the capability/skill
 * catalog, and cloud-sync tables. It has ZERO send/receive functions —
 * agent-to-agent messaging is owned by the conduit domain (conduit-sqlite.ts,
 * T344). The external `api.signaldock.io` URL is a Conduit transport CHANNEL, not
 * this local registry, and intentionally keeps its legacy hostname.
 *
 * ## E6-L5 — thin-facade migration (T11525)
 *
 * `ensureGlobalAgentRegistryDb()` is a thin facade that delegates the database
 * open to {@link openDualScopeDb}('global') — the canonical dual-scope chokepoint
 * (E3/E4 · T11512/T11517) already adopted by the tasks domain (E6-L1, T11521),
 * the brain domain (E6-L2, T11522), the conduit domain (E6-L3, T11523), and the
 * nexus domain (E6-L4, T11524). The Agent Registry tables live inside the
 * consolidated GLOBAL `cleo.db` under {@link getCleoHome}, sharing the SAME native
 * handle the nexus / skills global domains use.
 *
 * ## COMPLETE-CUTOVER to prefixed `agent_registry_*` tables (T11622 · folds T11578 AC2)
 *
 * The Agent Registry runtime READ + WRITE path now targets the PREFIXED
 * consolidated tables (`agent_registry_agents`, `agent_registry_capabilities`,
 * `agent_registry_skills`, …) that the consolidated cleo-global migration creates
 * (20260531000001 + the 20260602000001_t11622 `ALTER TABLE … RENAME` flip) — NOT
 * the legacy BARE tables (`agents`, `capabilities`, …). The schema barrel imported
 * below is therefore `schema/cleo-global/agent-registry.ts` (the prefixed target
 * shape: TEXT ISO-8601 timestamps + CHECK constraints), replacing the legacy
 * `schema/agent-registry-schema.ts` bare shape.
 *
 * The drizzle journal `runAgentRegistryMigrations` reconciles now only needs the
 * two legacy `_agent_registry_meta` / `_agent_registry_migrations` health-probe
 * tables that the consolidated migration omits (mirrors the conduit AC4 pattern).
 * The 13 prefixed `agent_registry_*` tables are owned by the consolidated migration
 * (single SSoT) — this domain no longer creates a disjoint bare runtime shape.
 *
 * Migration folder: packages/core/migrations/drizzle-agent-registry/
 *
 * GLOBAL-TIER ONLY. This module MUST NOT resolve paths under any project's .cleo/
 * directory. The path guard in getGlobalAgentRegistryDbPath() enforces this.
 *
 * @task T346
 * @task T1166
 * @task T11525 - E6-L5: route ensureGlobalAgentRegistryDb through openDualScopeDb('global')
 * @task T11622 - Signaldock → Agent Registry rename + runtime cutover to agent_registry_* (folds T11578 AC2)
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
// E6-L5 (T11525): dual-scope chokepoint — the Agent Registry domain opens the
// consolidated GLOBAL `cleo.db` through here. openDualScopeDb manages the
// DatabaseSync lifecycle, pragmas, and the consolidated migrations (which create
// the prefixed `agent_registry_*` tables). T11622 routes the runtime read/write
// path onto those prefixed tables; this module only reconciles the legacy
// health-probe ledger via the drizzle-agent-registry forward migration.
import { _resetDualScopeDbCache, openDualScopeDb } from './dual-scope-db.js';
import { migrateSanitized, reconcileJournal } from './migration-manager.js';
import { resolveCorePackageMigrationsFolder } from './resolve-migrations-folder.js';
import * as agentRegistrySchema from './schema/cleo-global/agent-registry.js';

/**
 * Database file name within the global cleo home directory.
 *
 * @task T346
 * @epic T310
 */
export const GLOBAL_AGENT_REGISTRY_DB_FILENAME = 'signaldock.db';

/**
 * Schema version for the global Agent Registry database.
 *
 * @task T346
 * @epic T310
 */
export const GLOBAL_AGENT_REGISTRY_SCHEMA_VERSION = '2026.4.12';

/**
 * @deprecated Use GLOBAL_AGENT_REGISTRY_SCHEMA_VERSION. T310 is done (archived).
 * Retained only because packages/core/src/internal.ts re-exports this name.
 * Removal blocked until internal.ts export is cleaned up.
 * Tracking: T355 / T1508 P2-NEW-2 — remove in v2026.5.0.
 */
export const AGENT_REGISTRY_SCHEMA_VERSION = GLOBAL_AGENT_REGISTRY_SCHEMA_VERSION;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Returns the GLOBAL-tier Agent Registry DB path — the consolidated GLOBAL
 * `cleo.db`.
 *
 * E6-L5 (T11525): resolves `getCleoHome()` + `cleo.db` (the same path
 * {@link openDualScopeDb}('global') opens). The Agent Registry holds canonical
 * agent identity + cloud-sync tables and stays GLOBAL — its tables live inside the
 * consolidated GLOBAL `cleo.db`, NOT a separate file. Project-local messaging state
 * lives in conduit.db (T344).
 *
 * Guard: asserts the resolved path starts with getCleoHome() (defense in depth,
 * mirrors the ADR-036/037 pattern used by getNexusDbPath in nexus-sqlite.ts).
 *
 * @task T346
 * @task T11525
 * @epic T310
 * @epic T11249
 * @throws {Error} If resolved path is not under getCleoHome() — indicates a code
 *   path that bypasses canonical path resolution. Fix the caller, do not suppress.
 */
export function getGlobalAgentRegistryDbPath(): string {
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
      `BUG: getGlobalAgentRegistryDbPath() resolved to "${dbPath}" which is NOT under ` +
        `getCleoHome() ("${cleoHome}"). The Agent Registry is global-only per ADR-037. ` +
        `This indicates a code path that bypasses path resolution — ` +
        `fix the caller, do not suppress this error.`,
    );
  }
  return dbPath;
}

/**
 * @deprecated Use getGlobalAgentRegistryDbPath() directly. T310 is done (archived).
 * Blocked from deletion: two callers still use this shim and require migration:
 *   - packages/core/src/store/cross-db-cleanup.ts (calls with cwd — will throw)
 *   - packages/core/src/internal.ts (re-exports this name)
 * Fix: migrate cross-db-cleanup.ts to use getConduitDbPath() and remove from
 * internal.ts. Tracking: T355 / T1508 P2-NEW-2 — remove in v2026.5.0.
 *
 * When called WITHOUT arguments: returns the global-tier path (forwards to
 * getGlobalAgentRegistryDbPath()).
 *
 * When called WITH a non-undefined `cwd` argument: throws a migration error
 * immediately. The project-tier path is now owned by conduit-sqlite.ts (T344).
 *
 * @param cwd - Must be undefined. Any other value throws a migration error.
 * @task T346
 * @epic T310
 */
export function getAgentRegistryDbPath(cwd?: string): string {
  if (cwd !== undefined) {
    throw new Error(
      'getAgentRegistryDbPath(cwd) is removed as of T310 (v2026.4.12). ' +
        'The global Agent Registry is now global-only at $XDG_DATA_HOME/cleo/cleo.db. ' +
        'Use getGlobalAgentRegistryDbPath(), or for project-local messaging use ' +
        'getConduitDbPath() from conduit-sqlite.ts (T344).',
    );
  }
  return getGlobalAgentRegistryDbPath();
}

// ---------------------------------------------------------------------------
// Migration folder resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to the drizzle-agent-registry migrations folder inside
 * @cleocode/core, using ESM-native module resolution (T1177).
 *
 * Delegates to {@link resolveCorePackageMigrationsFolder} which handles
 * bundled dist/, workspace dev, and global-install layouts uniformly via
 * `import.meta.resolve()` + `createRequire().resolve()` fallback.
 *
 * @task T1166
 * @epic T1150
 */
export function resolveAgentRegistryMigrationsFolder(): string {
  return resolveCorePackageMigrationsFolder('drizzle-agent-registry');
}

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

/**
 * Reconcile + apply the drizzle-agent-registry migrations on the shared handle.
 *
 * Post-T11622 cutover the migration carries ONLY the legacy `_agent_registry_meta`
 * / `_agent_registry_migrations` health-probe ledger tables — the 13 prefixed
 * `agent_registry_*` runtime tables are owned by the consolidated cleo-global
 * migration (single SSoT). The reconcile sentinel is `_agent_registry_meta` (a
 * table THIS migration creates), so `reconcileJournal` Scenario 2 (orphan
 * deletion) stays dormant on first open — pinning the sentinel to a
 * migration-created table avoids corrupting the SHARED `__drizzle_migrations`
 * journal (the conduit AC4 pattern, T11578).
 *
 * @param nativeDb - An open DatabaseSync handle at the global consolidated cleo.db
 * @task T1166
 * @task T11622
 * @epic T1150
 */
function runAgentRegistryMigrations(nativeDb: DatabaseSync): void {
  const migrationsFolder = resolveAgentRegistryMigrationsFolder();

  // Reconcile the Drizzle journal before running migrations. Sentinel =
  // `_agent_registry_meta` (created by this domain's forward migration), so
  // Scenario 2 orphan-deletion stays dormant on a fresh consolidated open.
  reconcileJournal(nativeDb, migrationsFolder, '_agent_registry_meta', 'agent-registry');

  // Create the drizzle ORM wrapper and run any pending migrations (the
  // health-probe ledger tables). The schema is the prefixed consolidated shape.
  const db = drizzle({ client: nativeDb, schema: agentRegistrySchema });
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
 * domains. The Agent Registry domain MUST NOT close it directly (see
 * {@link _resetGlobalAgentRegistryDb_TESTING_ONLY}).
 */
let _globalAgentRegistryNativeDb: DatabaseSync | null = null;

/**
 * Read the `schema_version` row from `_agent_registry_meta` if it exists.
 *
 * Used by {@link ensureGlobalAgentRegistryDb} as a fast-path sentinel: when the
 * value matches {@link GLOBAL_AGENT_REGISTRY_SCHEMA_VERSION} we know the DB is
 * fully bootstrapped + migrated to the in-process code version, so we can skip the
 * {@link runAgentRegistryMigrations} pipeline on every CLI invocation (T9027 —
 * epic T9026, CLI startup tax reduction).
 *
 * Defensive: returns `null` if the meta table is missing or the row is absent.
 * Any throw is swallowed — a sentinel miss simply forces the fall-through
 * migration replay path which is safe.
 *
 * @param db - An open global cleo.db handle.
 * @returns The schema_version string, or `null` if absent / unreadable.
 * @task T9027
 * @epic T9026
 */
function readAgentRegistrySchemaVersionSentinel(db: DatabaseSync): string | null {
  try {
    const row = db
      .prepare("SELECT value FROM _agent_registry_meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * Write the in-process schema version into `_agent_registry_meta`.
 *
 * Creates the meta table if missing and stamps the current version so the next
 * process can short-circuit via {@link readAgentRegistrySchemaVersionSentinel}.
 *
 * @param db - An open global cleo.db handle (post-migration).
 * @task T9027
 * @epic T9026
 */
function writeAgentRegistrySchemaVersionSentinel(db: DatabaseSync): void {
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS _agent_registry_meta (
         key TEXT PRIMARY KEY,
         value TEXT NOT NULL,
         updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
       );
       INSERT OR REPLACE INTO _agent_registry_meta (key, value, updated_at)
       VALUES ('schema_version', '${GLOBAL_AGENT_REGISTRY_SCHEMA_VERSION}', strftime('%s', 'now'));`,
    );
  } catch {
    // Non-fatal: if the meta write fails, ensure() still succeeds. Next
    // invocation will simply take the fall-through path (sentinel miss).
  }
}

/**
 * Ensure the global Agent Registry tables exist inside the consolidated GLOBAL
 * `cleo.db`. Creates the global cleo home directory if it doesn't exist.
 * Idempotent — safe to call multiple times.
 *
 * Post-T11622 cutover: the prefixed `agent_registry_*` runtime tables are created
 * by the consolidated cleo-global migration that `openDualScopeDb('global')` runs.
 * This function then reconciles the legacy health-probe ledger via the
 * drizzle-agent-registry migration. It no longer creates the bare-named tables.
 *
 * @returns Object with action ('created' | 'exists') and the database path.
 * @task T346
 * @task T1166
 * @task T11622
 * @epic T310
 */
export async function ensureGlobalAgentRegistryDb(): Promise<{
  action: 'created' | 'exists';
  path: string;
}> {
  const dbPath = getGlobalAgentRegistryDbPath();
  const alreadyExists = existsSync(dbPath);

  // ── Dual-scope chokepoint delegation (T11525 · E6-L5 / T11622 cutover) ────
  // openDualScopeDb('global') applies the pragma SSoT, creates the directory,
  // and runs the consolidated cleo-global migrations (which create the prefixed
  // `agent_registry_*` tables + apply the 20260602000001_t11622 rename). We
  // extract its native handle so we can reconcile the legacy health-probe ledger.
  const dualHandle = await openDualScopeDb('global');

  // Extract the underlying DatabaseSync. Drizzle exposes it via `$client`.
  const nativeDb = (dualHandle.db as { $client?: DatabaseSync }).$client ?? null;
  if (!nativeDb) {
    throw new Error(
      'E6-L5: openDualScopeDb returned a handle without $client — ' +
        'cannot extract DatabaseSync for the Agent Registry ledger reconcile.',
    );
  }

  // Sentinel: the prefixed `agent_registry_agents` table (created by the
  // consolidated migration) — the table this domain's runtime now reads/writes.
  const hasSchema = (() => {
    try {
      const result = nativeDb
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_registry_agents'",
        )
        .get() as { name: string } | undefined;
      return !!result;
    } catch {
      return false;
    }
  })();

  // T9027 — Schema-version sentinel fast path (epic T9026, CLI startup tax).
  // If the consolidated schema is applied AND `_agent_registry_meta.schema_version`
  // equals the in-process constant, skip the reconcile/migrate pass.
  if (
    hasSchema &&
    readAgentRegistrySchemaVersionSentinel(nativeDb) === GLOBAL_AGENT_REGISTRY_SCHEMA_VERSION
  ) {
    _globalAgentRegistryNativeDb = nativeDb;
    return { action: 'exists', path: dbPath };
  }

  // Reconcile + apply the drizzle-agent-registry health-probe ledger migration.
  runAgentRegistryMigrations(nativeDb);

  // Stamp schema_version sentinel so the next process can take the fast path.
  writeAgentRegistrySchemaVersionSentinel(nativeDb);

  // Store native handle for backup integration (getGlobalAgentRegistryNativeDb).
  _globalAgentRegistryNativeDb = nativeDb;

  return {
    action: alreadyExists && hasSchema ? 'exists' : 'created',
    path: dbPath,
  };
  // NOTE: We intentionally do NOT close the native handle — it is the SHARED
  // dual-scope GLOBAL `cleo.db` handle (E6-L5), co-owned by the nexus / skills
  // global domains. Its lifecycle is owned by `openDualScopeDb`.
}

/**
 * @deprecated Use ensureGlobalAgentRegistryDb(). T310 is done (archived).
 * Blocked from deletion: caller still uses this shim and requires migration:
 *   - packages/core/src/upgrade.ts calls ensureAgentRegistryDb(projectRootForMaint)
 *     (with cwd arg — will throw at runtime). Must migrate to ensureConduitDb(cwd).
 *   - packages/core/src/internal.ts re-exports this name.
 * Tracking: T355 / T1508 P2-NEW-2 — remove in v2026.5.0.
 *
 * When called WITHOUT arguments: forwards to ensureGlobalAgentRegistryDb().
 * When called WITH a non-undefined `cwd` argument: throws a migration error.
 *
 * @param cwd - Must be undefined. Any other value throws a migration error.
 * @task T346
 * @epic T310
 */
export async function ensureAgentRegistryDb(
  cwd?: string,
): Promise<{ action: 'created' | 'exists'; path: string }> {
  if (cwd !== undefined) {
    throw new Error(
      'ensureAgentRegistryDb(cwd) is removed as of T310 (v2026.4.12). ' +
        'The global Agent Registry is now global-only. ' +
        'Use ensureGlobalAgentRegistryDb() for global identity, or ' +
        'ensureConduitDb(cwd) from conduit-sqlite.ts for project messaging (T344).',
    );
  }
  return ensureGlobalAgentRegistryDb();
}

/**
 * Check global Agent Registry health: table count, WAL mode, schema version.
 * Used by `cleo doctor` to verify global Agent Registry integrity.
 *
 * E6-L5 (T11525): reads against the SHARED consolidated GLOBAL `cleo.db` handle
 * (via {@link ensureGlobalAgentRegistryDb}, which routes through
 * {@link openDualScopeDb}('global')). The metrics describe the consolidated
 * `cleo.db` that hosts the prefixed `agent_registry_*` tables.
 *
 * @returns Health report object, or object with exists=false if the DB does not exist.
 * @task T346
 * @task T11525
 * @epic T310
 * @epic T11249
 */
export async function checkGlobalAgentRegistryDbHealth(): Promise<{
  exists: boolean;
  path: string;
  tableCount: number;
  walMode: boolean;
  schemaVersion: string | null;
  foreignKeysEnabled: boolean;
} | null> {
  const dbPath = getGlobalAgentRegistryDbPath();
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
  // consolidated `cleo.db` handle. ensureGlobalAgentRegistryDb() is idempotent and
  // stores the handle in _globalAgentRegistryNativeDb.
  await ensureGlobalAgentRegistryDb();
  const nativeDb = _globalAgentRegistryNativeDb;
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
  // migrations applied. Fallback to _agent_registry_meta for pre-T1166 DBs.
  let schemaVersion: string | null = null;
  try {
    const journalRow = nativeDb
      .prepare('SELECT COUNT(*) as cnt FROM "__drizzle_migrations"')
      .get() as { cnt: number } | undefined;
    if (journalRow && journalRow.cnt > 0) {
      schemaVersion = GLOBAL_AGENT_REGISTRY_SCHEMA_VERSION;
    }
  } catch {
    // __drizzle_migrations does not exist yet — fall through to _agent_registry_meta
  }

  if (!schemaVersion) {
    try {
      const meta = nativeDb
        .prepare("SELECT value FROM _agent_registry_meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined;
      schemaVersion = meta?.value ?? null;
    } catch {
      // _agent_registry_meta may not exist on very old or partially-initialized DBs
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
 * @deprecated Use checkGlobalAgentRegistryDbHealth(). T310 is done (archived).
 * Retained only because packages/core/src/internal.ts re-exports this name.
 * Removal blocked until internal.ts export is cleaned up.
 * Tracking: T355 / T1508 P2-NEW-2 — remove in v2026.5.0.
 *
 * When called WITHOUT arguments: forwards to checkGlobalAgentRegistryDbHealth().
 * When called WITH a non-undefined `cwd` argument: throws a migration error.
 *
 * @param cwd - Must be undefined. Any other value throws a migration error.
 * @task T346
 * @epic T310
 */
export async function checkAgentRegistryDbHealth(cwd?: string): Promise<{
  exists: boolean;
  path: string;
  tableCount: number;
  walMode: boolean;
  schemaVersion: string | null;
  foreignKeysEnabled: boolean;
} | null> {
  if (cwd !== undefined) {
    throw new Error(
      'checkAgentRegistryDbHealth(cwd) is removed as of T310 (v2026.4.12). ' +
        'The global Agent Registry is now global-only. ' +
        'Use checkGlobalAgentRegistryDbHealth() for global health, or ' +
        'checkConduitDbHealth(cwd) from conduit-sqlite.ts for project conduit health (T344).',
    );
  }
  return checkGlobalAgentRegistryDbHealth();
}

/**
 * Get the underlying node:sqlite DatabaseSync instance for the global Agent
 * Registry (consolidated `cleo.db`). Returns the handle stored by the most recent
 * ensureGlobalAgentRegistryDb() call, or null if not yet initialized in this
 * process.
 *
 * Used by sqlite-backup.ts to activate the GLOBAL_SNAPSHOT_TARGET (spec §6.2, T310).
 *
 * @task T346
 * @epic T310
 */
export function getGlobalAgentRegistryNativeDb(): DatabaseSync | null {
  return _globalAgentRegistryNativeDb;
}

/**
 * Reset the in-process global Agent Registry singleton.
 * ONLY for use in test isolation — never call in production code.
 *
 * ## E6-L5 (T11525) — shared-handle close rule
 *
 * `_globalAgentRegistryNativeDb` is the SHARED consolidated GLOBAL `cleo.db` handle
 * owned by {@link openDualScopeDb}('global') and co-owned by the nexus / skills
 * global domains. This reset MUST NOT call `.close()` on it directly — doing so
 * would tear the handle out from under nexus / skills (the exact bug class L4 fixed
 * at `dual-scope-db.ts`). Instead it evicts the GLOBAL-scope entry from the
 * dual-scope cache and drops the local reference. The next
 * `ensureGlobalAgentRegistryDb()` re-opens a fresh consolidated handle.
 *
 * @task T346
 * @task T11525
 * @epic T310
 * @epic T11249
 */
export function _resetGlobalAgentRegistryDb_TESTING_ONLY(): void {
  _globalAgentRegistryNativeDb = null;
  _resetDualScopeDbCache('global');
}
