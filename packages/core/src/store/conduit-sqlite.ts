/**
 * SQLite store for the project-scope CONDUIT domain — agent-to-agent messaging,
 * delivery queue, attachments, A2A topics, and per-project agent refs.
 *
 * ## E6-L3 — thin-facade migration (T11523)
 *
 * `ensureConduitDb()` is now a thin facade that delegates the database open to
 * {@link openDualScopeDb}('project', cwd) — the canonical dual-scope chokepoint
 * introduced by E3/E4 (T11512/T11517) and already adopted by the tasks domain
 * (E6-L1, T11521) and brain domain (E6-L2, T11522). This ensures:
 *
 * - Every conduit-domain open flows through the single pragma SSoT (ADR-068/069).
 * - The conduit tables now live inside the consolidated project `cleo.db` — NOT a
 *   separate `conduit.db` file — co-existing with `tasks_*` / `brain_*` / etc.
 * - DB Open Guard Gate 3 (`scripts/lint-no-direct-db-open.mjs`) stays green: the
 *   only native open is inside `dual-scope-db.ts`.
 *
 * ## COMPLETE-CUTOVER to prefixed `conduit_*` tables (T11578 · AC4)
 *
 * The conduit runtime READ + WRITE path now targets the PREFIXED consolidated
 * tables (`conduit_conversations`, `conduit_messages`, `conduit_topics`, …) that
 * the consolidated cleo-project migration creates — NOT the legacy BARE tables
 * (`conversations`, `messages`, …). The schema barrel imported below is therefore
 * `schema/cleo-project/conduit.ts` (the prefixed target shape, TEXT ISO-8601
 * timestamps + CHECK constraints), replacing the legacy `schema/conduit-schema.ts`
 * bare shape. The drizzle journal `runConduitMigrations` reconciles now only needs
 * the FTS5 quartet that the consolidated migration omits (drizzle-orm sqlite-core
 * does not model FTS5 virtual tables).
 *
 * ## Inline DDL → forward migration (T11523 → T11578)
 *
 * The legacy 16-table inline `CONDUIT_SCHEMA_SQL` blob was first converted to a
 * forward Drizzle migration under
 * `migrations/drizzle-conduit/20260601000003_t11523-conduit-inline-schema`
 * (T11523, bare runtime shape). The AC4 cutover (T11578) rewrote that migration to
 * carry ONLY the `conduit_messages_fts` FTS5 virtual table + its 3 sync triggers
 * (`conduit_messages_ai/ad/au`) + the two legacy `_conduit_meta` /
 * `_conduit_migrations` health-probe tables. The 14 prefixed `conduit_*` tables
 * are owned by the consolidated cleo-project migration (single SSoT) — this
 * migration no longer creates them.
 *
 * ## Single physical shape (consolidated owns the tables)
 *
 * After AC4 the runtime writes the SAME prefixed `conduit_*` tables the
 * consolidated schema (`cleo-project/conduit.ts`) declares — there is no longer a
 * disjoint bare runtime shape. The exodus migration (T11248 / T11553) still
 * renames any LEGACY bare data (`messages` → `conduit_messages`) from a
 * pre-cutover DB into those same prefixed tables; the FTS index is rebuilt
 * post-migration from `conduit_messages` (exodus skips `*_fts` tables).
 *
 * Architecture (ADR-037):
 *   conduit (this module) — project-scoped — messaging, delivery, attachments,
 *                  project_agent_refs
 *   signaldock.db — global-scoped (T346) — agents, capabilities, cloud-sync tables
 *
 * @task T344
 * @task T1407
 * @task T11523 - E6-L3: route ensureConduitDb through openDualScopeDb (SG-DB-SUBSTRATE-V2)
 * @epic T310
 * @epic T11249
 * @why ADR-037 splits single signaldock.db into project-tier conduit
 *      (this module) and global-tier signaldock.db (T346). T1407 unifies
 *      conduit under the canonical Drizzle migration runner; T11523 routes it
 *      through the consolidated `cleo.db` dual-scope chokepoint.
 * @what Path helper, database initializer (dual-scope facade), Drizzle migration
 *       runner wiring, health check, native DB accessor, and project_agent_refs
 *       CRUD accessors.
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
// underscore-import: node:sqlite type alias required for createRequire interop.
// The runtime node:sqlite loading is handled by openDualScopeDb() /
// openNativeDatabase() in their respective leaf modules. The type import is
// erased at runtime and is safe.
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import type { ProjectAgentRef } from '@cleocode/contracts';
// Lazy-loaded drizzle factory (see _getDrizzle). drizzle-orm/node-sqlite
// statically imports node:sqlite, so a top-level value import would pull the
// native binding at module-load — defeating the lazy-init invariant. The type
// import is erased at runtime and is safe.
import type { drizzle as drizzleFn } from 'drizzle-orm/node-sqlite';
// E6-L3 (T11523): dual-scope chokepoint — the conduit domain now opens the
// consolidated project `cleo.db` through here. openDualScopeDb manages the
// DatabaseSync lifecycle, pragmas, and consolidated migrations. We extract the
// native handle and re-wrap it with the legacy conduit-schema drizzle instance so
// existing callers compile and run without change.
import { openDualScopeDb, resolveDualScopeDbPath } from './dual-scope-db.js';
import { migrateSanitized, reconcileJournal } from './migration-manager.js';
import {
  resolveConsolidatedJournalSiblings,
  resolveCorePackageMigrationsFolder,
} from './resolve-migrations-folder.js';
import * as conduitSchema from './schema/cleo-project/conduit.js';
import { applyPerfPragmas } from './sqlite-pragmas.js';

const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync;
};

/**
 * Cached `drizzle` factory from `drizzle-orm/node-sqlite`, loaded on first use.
 *
 * Loaded via `createRequire` rather than a top-level import so that importing
 * `conduit-sqlite.ts` does not eagerly pull in `node:sqlite` (which the drizzle
 * driver statically imports). Memoized after the first call. Mirrors the
 * `_getDrizzle` lazy pattern in sqlite.ts / memory-sqlite.ts (T11280/T11521/T11522).
 *
 * @internal
 * @task T11523
 */
let _drizzle: typeof drizzleFn | null = null;

/**
 * Returns the `drizzle` factory, loading `drizzle-orm/node-sqlite` on first call.
 *
 * @internal
 * @task T11523
 */
function _getDrizzle(): typeof drizzleFn {
  if (_drizzle === null) {
    const mod = _require('drizzle-orm/node-sqlite') as { drizzle: typeof drizzleFn };
    _drizzle = mod.drizzle;
  }
  return _drizzle;
}

/**
 * Legacy database file name. Retained as an export for backwards compatibility
 * with callers that still reference the constant; the conduit domain now lives
 * inside the consolidated project `cleo.db` (E6-L3, T11523).
 *
 * @deprecated The conduit domain no longer has a standalone `conduit.db` file —
 *   it is served from the project `cleo.db`. Use {@link getConduitDbPath}.
 */
export const CONDUIT_DB_FILENAME = 'conduit.db';

/**
 * Schema version for the conduit domain.
 *
 * Bumped only when the conduit Drizzle schema changes. Pinned at the post-T1252
 * A2A topics value; retained for backwards compatibility with pre-T1407 health
 * checks that read `_conduit_meta.schema_version`.
 */
export const CONDUIT_SCHEMA_VERSION = '2026.4.23';

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let _conduitNativeDb: DatabaseSync | null = null;
let _conduitDbPath: string | null = null;
/** Guard against concurrent initialization (async dual-scope open). */
let _initPromise: Promise<{ action: 'created' | 'exists'; path: string }> | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the project-scope conduit database path.
 *
 * ## E6-L3 (T11523)
 *
 * After the dual-scope migration, `ensureConduitDb()` opens the consolidated
 * project `cleo.db` via {@link openDualScopeDb} — not the legacy standalone
 * `conduit.db`. This function therefore returns the dual-scope `cleo.db` path so
 * that callers checking for the file `ensureConduitDb()` created (existence /
 * backup / health probes) point at the correct file.
 *
 * The supplied `projectRoot` is passed through as the `cwd` for the SSoT
 * resolver, which walks up to find the `.cleo/` directory.
 *
 * @task T344
 * @task T11523
 * @epic T310
 * @param projectRoot - Absolute path to the project root directory.
 * @returns Absolute path to the project `cleo.db`.
 */
export function getConduitDbPath(projectRoot: string): string {
  return resolveDualScopeDbPath('project', projectRoot);
}

/**
 * Resolve the absolute path to the drizzle-conduit migrations folder inside
 * `@cleocode/core`, using ESM-native module resolution (T1177 pattern).
 *
 * @task T1407
 * @epic T310
 */
export function resolveConduitMigrationsFolder(): string {
  return resolveCorePackageMigrationsFolder('drizzle-conduit');
}

/**
 * Apply the conduit-domain schema to an arbitrary open `DatabaseSync` handle by
 * running the `drizzle-conduit` migration set against it.
 *
 * ## E6-L3 (T11523)
 *
 * Previously this executed the inline `CONDUIT_SCHEMA_SQL` blob directly. That
 * blob has been moved into the forward migration
 * `20260601000003_t11523-conduit-inline-schema`, so this helper now reconciles
 * the journal and runs the conduit migrations — the same path `ensureConduitDb`
 * uses internally. It remains exported for the signaldock→conduit migration
 * executor (T358) and characterization tests that need to seed the conduit schema
 * onto a caller-owned handle.
 *
 * Idempotent: every migration statement uses `IF NOT EXISTS`, so applying it onto
 * an already-populated DB is a no-op (the journal reconciler marks it applied).
 *
 * @task T344
 * @task T1407
 * @task T11523
 * @epic T310
 * @param db - An open node:sqlite DatabaseSync instance.
 */
export function applyConduitSchema(db: DatabaseSync): void {
  runConduitMigrations(db);
}

/**
 * Run Drizzle migrations to reconcile and update the conduit schema on the given
 * native handle.
 *
 * Uses `reconcileJournal()` + `migrateSanitized()` from migration-manager.ts —
 * the canonical SSoT for SQLite migration semantics shared with tasks/brain/
 * nexus/signaldock/telemetry. The conduit `__drizzle_migrations` journal lives in
 * the same `cleo.db` as the consolidated cleo-project journal; the hashes are
 * disjoint, so the conduit migrations reconcile/apply independently.
 *
 * The existence sentinel is `_conduit_meta` (T11578 · AC4) — a table the conduit
 * forward migration ITSELF creates, NOT one the consolidated migration owns. This
 * is critical: `reconcileJournal` Scenario 2 (orphan deletion) is gated on the
 * sentinel already existing. The consolidated cleo-project migration runs FIRST
 * (via `openDualScopeDb`) and writes its OWN entries into the SHARED
 * `__drizzle_migrations` journal; if the sentinel were a consolidated-owned table
 * (e.g. `conduit_messages`) it would already exist on the first conduit open, so
 * Scenario 2 would fire, see the consolidated entries as "orphans" (absent from
 * the conduit folder), and DELETE them — corrupting the consolidated journal and
 * forcing a destructive re-run on the next open (`table … already exists`).
 * Pinning the sentinel to a conduit-migration-created table keeps Scenario 2
 * dormant until the conduit set is journaled, exactly as the pre-cutover bare
 * `conversations` sentinel did.
 *
 * @task T1407
 * @task T11523
 * @task T11578
 * @epic T310
 */
function runConduitMigrations(nativeDb: DatabaseSync): void {
  const migrationsFolder = resolveConduitMigrationsFolder();

  // Reconcile the Drizzle journal first so existing DBs don't try to re-run the
  // comment-only baseline marker (Scenario 3 marks it applied immediately when
  // the schema already matches). Sentinel = `_conduit_meta` (created by the
  // conduit migration itself — see the doc note above on why it must NOT be a
  // consolidated-owned table).
  // T11829: conduit shares the consolidated PROJECT cleo.db journal — pass the
  // OTHER lineages so their rows are not deleted as cross-lineage orphans.
  reconcileJournal(
    nativeDb,
    migrationsFolder,
    '_conduit_meta',
    'conduit',
    resolveConsolidatedJournalSiblings('drizzle-conduit'),
  );

  const db = _getDrizzle()({ client: nativeDb, schema: conduitSchema });
  migrateSanitized(db, { migrationsFolder });
}

/**
 * Initialize the project-scope CONDUIT domain SQLite database (lazy, singleton).
 *
 * ## E6-L3 façade (T11523)
 *
 * Delegates the physical DB open to {@link openDualScopeDb}('project', cwd) — the
 * canonical dual-scope chokepoint. openDualScopeDb applies the pragma SSoT,
 * creates the directory, runs the consolidated cleo-project migrations (which
 * create the prefixed `conduit_*` tables), and manages the singleton cache. We
 * extract its native handle (`$client`) and run the `drizzle-conduit` migration on
 * it to (idempotently) create the `conduit_messages_fts` FTS5 quartet that the
 * consolidated migration omits. After the AC4 cutover (T11578) the LocalTransport +
 * accessor writers query the SAME prefixed `conduit_*` tables — the exodus
 * migration (T11248 / T11553) renames any pre-cutover BARE data into them.
 *
 * On subsequent calls the existing singleton is returned immediately if the
 * resolved path matches AND the shared handle is still live (liveness guard);
 * otherwise it re-derives from the live dual-scope cache.
 *
 * Uses a promise guard so concurrent callers wait for the same initialization to
 * complete (the dual-scope open is async).
 *
 * @task T344
 * @task T1407
 * @task T11523
 * @epic T310
 * @param projectRoot - Absolute path to the project root directory.
 * @returns Object with `action` (`'created'` | `'exists'`) and `path`.
 */
export async function ensureConduitDb(
  projectRoot: string,
): Promise<{ action: 'created' | 'exists'; path: string }> {
  const dbPath = getConduitDbPath(projectRoot);

  // Liveness guard (T11523): the conduit domain SHARES the consolidated cleo.db
  // handle with the tasks + brain domains. Another domain may have closed +
  // re-opened the shared `DatabaseSync` (e.g. its reset / auto-recovery path)
  // while our conduit singleton still references the now-closed handle. Detect a
  // stale (closed) handle, or a singleton bound to a different path, and drop it
  // so we re-derive from the live openDualScopeDb cache below.
  if (_conduitNativeDb && (!_conduitNativeDb.isOpen || _conduitDbPath !== dbPath)) {
    resetConduitDbState();
  }

  // If singleton already open at the same path and live, skip re-initialization.
  if (_conduitNativeDb && _conduitDbPath === dbPath) {
    return { action: 'exists', path: dbPath };
  }

  // If already initializing, wait for the in-flight init.
  if (_initPromise) return _initPromise;

  _initPromise = (async (): Promise<{ action: 'created' | 'exists'; path: string }> => {
    const alreadyExists = existsSync(dbPath);

    // ── Dual-scope chokepoint delegation (T11523 · E6-L3) ──────────────────
    // openDualScopeDb applies the pragma SSoT, creates the directory, runs the
    // consolidated cleo-project migrations (which create the `conduit_*` tables),
    // and manages the singleton cache. We extract its native handle so we can run
    // the legacy `drizzle-conduit` migrations for caller compatibility.
    const dualHandle = await openDualScopeDb('project', projectRoot);

    // Extract the underlying DatabaseSync. Drizzle exposes it via `$client`.
    const nativeDb = (dualHandle.db as { $client?: DatabaseSync }).$client ?? null;
    if (!nativeDb) {
      throw new Error(
        'E6-L3: openDualScopeDb returned a handle without $client — ' +
          'cannot extract DatabaseSync for legacy conduit-schema wrapping.',
      );
    }

    // Establish the FTS5 index over the consolidated `conduit_messages` table.
    // The consolidated migrations already created the prefixed `conduit_*` tables;
    // running the `drizzle-conduit` set adds the `conduit_messages_fts` virtual
    // table + its 3 sync triggers (drizzle-orm cannot model FTS5, so the
    // consolidated migration omits them). Idempotent: a no-op once the FTS index
    // already exists (T11578 · AC4).
    runConduitMigrations(nativeDb);

    // Record schema version in the legacy `_conduit_meta` table for backwards-
    // compatible health-check consumers (checkConduitDbHealth and any external
    // tooling that grepped the meta table prior to T1407). The Drizzle journal
    // (`__drizzle_migrations`) is the canonical migration source-of-truth.
    nativeDb.exec(
      `INSERT OR REPLACE INTO _conduit_meta (key, value, updated_at)
       VALUES ('schema_version', '${CONDUIT_SCHEMA_VERSION}', strftime('%s', 'now'))`,
    );

    _conduitNativeDb = nativeDb;
    _conduitDbPath = dbPath;

    return { action: alreadyExists ? 'exists' : 'created', path: dbPath };
  })();

  try {
    return await _initPromise;
  } finally {
    _initPromise = null;
  }
}

/**
 * Returns the live node:sqlite DatabaseSync handle for the conduit domain.
 *
 * Returns `null` if `ensureConduitDb` has not been called yet for this process,
 * or if the shared handle has been closed since the last open.
 *
 * @task T344
 * @epic T310
 * @returns The open DatabaseSync instance, or `null` if not initialized.
 */
export function getConduitNativeDb(): DatabaseSync | null {
  return _conduitNativeDb;
}

/**
 * Close the conduit-domain database connection and reset the module singleton.
 *
 * ## E6-L3 (T11523)
 *
 * The conduit domain now SHARES the consolidated project `cleo.db` handle with
 * the tasks + brain domains (all open it via {@link openDualScopeDb}, same cache
 * key). This function therefore must NOT close the underlying `DatabaseSync` nor
 * evict the dual-scope cache — doing so would break in-flight tasks/brain-domain
 * queries with "database is not open". It only drops the conduit-domain singleton
 * references; the shared handle's lifecycle is owned by `openDualScopeDb` and torn
 * down by a coordinated reset (`closeAllDatabases` → `_resetDualScopeDbCache`).
 *
 * Safe to call multiple times.
 *
 * @task T344
 * @task T11523
 * @epic T310
 */
export function closeConduitDb(): void {
  // Drop only the conduit singleton references. Do NOT close `_conduitNativeDb`
  // — it is the shared dual-scope handle, possibly still in use by tasks/brain.
  _conduitNativeDb = null;
  _conduitDbPath = null;
  _initPromise = null;
}

/**
 * Reset conduit-domain singleton state without saving.
 *
 * Used during tests or when the shared database handle is recreated. Drops only
 * the conduit-domain singleton references — does NOT close the shared dual-scope
 * `cleo.db` handle nor evict the dual-scope cache (that handle is shared with the
 * tasks + brain domains). Mirrors {@link closeConduitDb}. Safe to call multiple
 * times.
 *
 * @task T11523
 * @epic T310
 */
export function resetConduitDbState(): void {
  _conduitNativeDb = null;
  _conduitDbPath = null;
  _initPromise = null;
}

// ---------------------------------------------------------------------------
// project_agent_refs CRUD accessors (T353)
// ---------------------------------------------------------------------------

/**
 * Attaches an agent to the current project. If a row exists with enabled=0,
 * re-enables it (update attached_at timestamp). If a row exists with enabled=1,
 * no-op. Inserts a new row otherwise.
 *
 * @param db - conduit handle (from ensureConduitDb).
 * @param agentId - Global signaldock.db:agents.id (soft FK, not validated here).
 * @param opts - Optional role and capabilities override.
 * @task T353
 * @epic T310
 */
export function attachAgentToProject(
  db: DatabaseSync,
  agentId: string,
  opts?: { role?: string | null; capabilitiesOverride?: string | null },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO conduit_project_agent_refs (agent_id, attached_at, role, capabilities_override, last_used_at, enabled)
     VALUES (?, ?, ?, ?, NULL, 1)
     ON CONFLICT(agent_id) DO UPDATE SET
       enabled = 1,
       attached_at = CASE WHEN conduit_project_agent_refs.enabled = 0 THEN excluded.attached_at ELSE conduit_project_agent_refs.attached_at END,
       role = excluded.role,
       capabilities_override = excluded.capabilities_override`,
  ).run(agentId, now, opts?.role ?? null, opts?.capabilitiesOverride ?? null);
}

/**
 * Detaches an agent from the current project by setting enabled=0.
 * Does NOT delete the row (preserves attachment history for audit).
 *
 * @param db - conduit handle (from ensureConduitDb).
 * @param agentId - Agent ID to detach.
 * @task T353
 * @epic T310
 */
export function detachAgentFromProject(db: DatabaseSync, agentId: string): void {
  db.prepare(`UPDATE conduit_project_agent_refs SET enabled = 0 WHERE agent_id = ?`).run(agentId);
}

/**
 * Lists project_agent_refs rows. By default returns only enabled=1 rows.
 * Pass enabledOnly=false to return all rows regardless of enabled state.
 *
 * @param db - conduit handle (from ensureConduitDb).
 * @param opts - Filter options. Defaults to `{ enabledOnly: true }`.
 * @returns Array of ProjectAgentRef rows ordered by attached_at DESC.
 * @task T353
 * @epic T310
 */
export function listProjectAgentRefs(
  db: DatabaseSync,
  opts?: { enabledOnly?: boolean },
): ProjectAgentRef[] {
  const enabledOnly = opts?.enabledOnly ?? true;
  const sql = enabledOnly
    ? `SELECT agent_id, attached_at, role, capabilities_override, last_used_at, enabled
       FROM conduit_project_agent_refs WHERE enabled = 1
       ORDER BY attached_at DESC`
    : `SELECT agent_id, attached_at, role, capabilities_override, last_used_at, enabled
       FROM conduit_project_agent_refs
       ORDER BY attached_at DESC`;
  const rows = db.prepare(sql).all() as Array<{
    agent_id: string;
    attached_at: string;
    role: string | null;
    capabilities_override: string | null;
    last_used_at: string | null;
    enabled: number;
  }>;
  return rows.map((r) => ({
    agentId: r.agent_id,
    attachedAt: r.attached_at,
    role: r.role,
    capabilitiesOverride: r.capabilities_override,
    lastUsedAt: r.last_used_at,
    enabled: r.enabled,
  }));
}

/**
 * Returns a single project_agent_refs row by agentId, or null if not found.
 *
 * @param db - conduit handle (from ensureConduitDb).
 * @param agentId - Agent ID to look up.
 * @returns The ProjectAgentRef row, or null if the agent is not attached.
 * @task T353
 * @epic T310
 */
export function getProjectAgentRef(db: DatabaseSync, agentId: string): ProjectAgentRef | null {
  const row = db
    .prepare(
      `SELECT agent_id, attached_at, role, capabilities_override, last_used_at, enabled
       FROM conduit_project_agent_refs WHERE agent_id = ?`,
    )
    .get(agentId) as
    | {
        agent_id: string;
        attached_at: string;
        role: string | null;
        capabilities_override: string | null;
        last_used_at: string | null;
        enabled: number;
      }
    | undefined;
  if (!row) return null;
  return {
    agentId: row.agent_id,
    attachedAt: row.attached_at,
    role: row.role,
    capabilitiesOverride: row.capabilities_override,
    lastUsedAt: row.last_used_at,
    enabled: row.enabled,
  };
}

/**
 * Updates the last_used_at timestamp for an agent to now.
 * No-op if the agent_id does not exist in project_agent_refs.
 *
 * @param db - conduit handle (from ensureConduitDb).
 * @param agentId - Agent ID to update.
 * @task T353
 * @epic T310
 */
export function updateProjectAgentLastUsed(db: DatabaseSync, agentId: string): void {
  db.prepare(`UPDATE conduit_project_agent_refs SET last_used_at = ? WHERE agent_id = ?`).run(
    new Date().toISOString(),
    agentId,
  );
}

/**
 * Checks conduit-domain health — table count, WAL mode, schema version, and
 * foreign keys status.
 *
 * ## E6-L3 (T11523)
 *
 * The conduit domain now lives in the consolidated project `cleo.db`. This probe
 * opens that file (read-only inspection of pragma + sqlite_master state) — it does
 * NOT require `ensureConduitDb` to have been called and opens/closes its own
 * short-lived connection. Used by `cleo doctor` to verify conduit integrity.
 *
 * @task T344
 * @task T11523
 * @epic T310
 * @param projectRoot - Absolute path to the project root directory.
 * @returns Health report object. `exists: false` when the DB is absent.
 */
export function checkConduitDbHealth(projectRoot: string): {
  exists: boolean;
  path: string;
  tableCount: number;
  walMode: boolean;
  schemaVersion: string | null;
  foreignKeysEnabled: boolean;
} {
  const dbPath = getConduitDbPath(projectRoot);

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

  const db = new DatabaseSync(dbPath);
  // Health-check is a short-lived read of pragma + sqlite_master state.
  // Apply the perf pragma set so the inspection itself benefits from mmap +
  // cache, and the connection doesn't sit at SQLite defaults if the writer
  // hasn't yet established WAL.
  applyPerfPragmas(db);
  try {
    const tables = db
      .prepare(
        "SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .get() as { count: number };

    const journalMode = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    const fkEnabled = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };

    let schemaVersion: string | null = null;
    try {
      const meta = db
        .prepare("SELECT value FROM _conduit_meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined;
      schemaVersion = meta?.value ?? null;
    } catch {
      // _conduit_meta may not exist on a partially-initialized DB.
    }

    return {
      exists: true,
      path: dbPath,
      tableCount: tables.count,
      walMode: journalMode.journal_mode === 'wal',
      schemaVersion,
      foreignKeysEnabled: fkEnabled.foreign_keys === 1,
    };
  } finally {
    db.close();
  }
}

/**
 * Open a fresh (non-singleton) connection to the conduit-domain DB with pragmas
 * applied.
 *
 * ## E6-L3 (T11523)
 *
 * The conduit domain now lives in the consolidated project `cleo.db`. This opens
 * an independent connection to that file (WAL mode permits concurrent
 * connections) that the caller owns and must close. Intended for callers that
 * manage connection lifecycle explicitly (e.g. LocalTransport connect/disconnect
 * cycle). The caller is responsible for ensuring `ensureConduitDb` has run first
 * so the bare conduit tables exist.
 *
 * Applies the pragma SSoT from `specs/sqlite-pragmas.json` (T9047, T9189).
 *
 * @param projectRoot - Project root for resolving the conduit DB path.
 * @returns An open DatabaseSync connection (caller must close).
 * @task T9189
 * @task T11523
 */
export function openFreshConduitDb(projectRoot: string): DatabaseSync {
  const dbPath = getConduitDbPath(projectRoot);
  const db = new DatabaseSync(dbPath);
  applyPerfPragmas(db);
  return db;
}
