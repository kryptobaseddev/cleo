/**
 * SQLite store for the project-scope BRAIN domain via drizzle-orm/node-sqlite +
 * node:sqlite (DatabaseSync).
 *
 * ## E6-L2 — thin-facade migration (T11522)
 *
 * `getBrainDb()` is now a thin facade that delegates the database open to
 * {@link openDualScopeDb}('project', cwd) — the canonical dual-scope chokepoint
 * introduced by E3/E4 (T11512/T11517) and already adopted by the tasks domain
 * (E6-L1, T11521). This ensures:
 *
 * - Every brain-domain open flows through the single pragma SSoT (ADR-068/069).
 * - The brain tables now live inside the consolidated project `cleo.db` — NOT a
 *   separate `brain.db` file — co-existing with `tasks_*` / `conduit_*` / etc.
 * - DB Open Guard Gate 3 (`scripts/lint-no-direct-db-open.mjs`) stays green: the
 *   only native open is inside `dual-scope-db.ts`.
 *
 * The legacy `drizzle-brain` migrations are still applied to this handle during
 * the E3→E6 transition (every brain migration is `CREATE TABLE IF NOT EXISTS` /
 * additive `ALTER TABLE`, so re-applying onto the consolidated `cleo.db` is
 * idempotent). This creates the legacy runtime-queried physical tables — most
 * notably `deriver_queue` (unprefixed; the consolidated schema carries the
 * prefixed `brain_deriver_queue`) — alongside the consolidated `brain_*` tables.
 * The exodus migration (T11248) renames them; E6-L7/L8 remove the legacy ones.
 *
 * ## Post-hoc DDL removal (T11522 acceptance criteria)
 *
 * Every `ensureColumns` band-aid (~15) and raw `CREATE TABLE IF NOT EXISTS`
 * (~8) that previously lived in {@link runBrainMigrations} has been removed. All
 * of them were redundant safety-nets fully covered by the `drizzle-brain`
 * migration files (the journal reconciler `probeAndMarkApplied` is robust enough
 * to detect already-applied DDL — see migration-manager.ts, T632). The ONE table
 * with no migration anywhere — `brain_task_observations` (T1615, a runtime-only
 * join cache mapped to `null` by exodus) — was converted to a forward Drizzle
 * migration under `migrations/drizzle-cleo-project/20260601000002_t11522-brain-task-observations`,
 * matching the T9179 precedent (ensureColumns → forward migration).
 *
 * @epic T5149
 * @task T5128
 * @task T11522 - E6-L2: route getBrainDb through openDualScopeDb (SG-DB-SUBSTRATE-V2)
 */

import { createRequire } from 'node:module';
// Type-only import for annotations. The runtime node:sqlite loading is handled
// by openDualScopeDb() / openNativeDatabase() in their respective leaf modules.
import type { DatabaseSync } from 'node:sqlite';
// Lazy-loaded drizzle factory (see _getDrizzle). drizzle-orm/node-sqlite
// statically imports node:sqlite, so a top-level value import would pull the
// native binding at module-load — defeating the lazy-init invariant. The type
// import is erased at runtime and is safe.
import type { drizzle as drizzleFn, NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
// E6-L2 (T11522): dual-scope chokepoint — the brain domain now opens the
// consolidated project `cleo.db` through here. openDualScopeDb manages the
// DatabaseSync lifecycle, pragmas, and consolidated migrations. We extract the
// native handle and re-wrap it with the legacy brain-schema drizzle instance so
// existing callers (brainSchema.* queries) compile and run without change.
import { getLogger } from '../logger.js';
import { type ProjectStore, resolveDualScopeDbPath } from './dual-scope-db.js';
import {
  createSafetyBackup,
  migrateWithRetry,
  reconcileBrainMigrationsForConsolidatedDb,
  reconcileJournal,
  tableExists,
} from './migration-manager.js';
// T12038: the brain domain no longer owns a singleton — the path-keyed binding
// registry does. This module contributes only its schema reconciliation.
import {
  bindProjectDomain,
  boundProjectNative,
  type DomainBinding,
  peekProjectDomain,
  releaseDomainBindings,
} from './ports/domain-binding.js';
import { resolveCorePackageMigrationsFolder } from './resolve-migrations-folder.js';
import * as brainSchema from './schema/memory-schema.js';
import { collapseTwinTables } from './twin-collapse.js';

const _require = createRequire(import.meta.url);

/**
 * Cached `drizzle` factory from `drizzle-orm/node-sqlite`, loaded on first use.
 *
 * Loaded via `createRequire` rather than a top-level import so that importing
 * `memory-sqlite.ts` does not eagerly pull in `node:sqlite` (which the drizzle
 * driver statically imports). Memoized after the first call. Mirrors the
 * `_getDrizzle` lazy pattern in sqlite.ts (T11280/T11521).
 *
 * @internal
 */
let _drizzle: typeof drizzleFn | null = null;

/**
 * Returns the `drizzle` factory, loading `drizzle-orm/node-sqlite` on first call.
 *
 * @internal
 * @task T11522
 */
function _getDrizzle(): typeof drizzleFn {
  if (_drizzle === null) {
    const mod = _require('drizzle-orm/node-sqlite') as { drizzle: typeof drizzleFn };
    _drizzle = mod.drizzle;
  }
  return _drizzle;
}

/** Schema version for newly created brain databases. Single source of truth. */
export const BRAIN_SCHEMA_VERSION = '1.0.0';

// ── No singleton state (E6-L14 · T12038) ─────────────────────────────────────
// This module used to own `_db` / `_nativeDb` / `_dbPath` / `_initPromise` /
// `_vecLoaded`. All five are gone. Caching, path keying, single-flight, and
// handle liveness belong to the path-keyed binding registry in
// `ports/domain-binding.ts`; `_vecLoaded` is now per-binding state on
// {@link BrainDomainHandle}, so two projects can differ on vec availability
// instead of racing one process-wide boolean.

/**
 * The brain domain's bound value: its Drizzle handle plus the per-database
 * `sqlite-vec` availability flag.
 *
 * @task T12038 (E6-L14)
 */
export interface BrainDomainHandle {
  /** Drizzle instance typed against the legacy brain schema. */
  readonly drizzle: NodeSQLiteDatabase;
  /** Whether the `sqlite-vec` extension loaded for THIS database. */
  readonly vecLoaded: boolean;
}

/**
 * Get the path to the brain-domain SQLite database file.
 *
 * ## E6-L2 (T11522)
 *
 * After the dual-scope migration, `getBrainDb()` opens the consolidated project
 * `cleo.db` via {@link openDualScopeDb} — not the legacy standalone `brain.db`.
 * This function therefore returns the dual-scope `cleo.db` path so that callers
 * checking for the file `getBrainDb()` created (existence / backup / health
 * probes) point at the correct file.
 */
export function getBrainDbPath(cwd?: string): string {
  return resolveDualScopeDbPath('project', cwd);
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
//
// E6-L2 (T11522): the legacy `runBrainMigrations` helper that ran the
// `drizzle-brain` migration folder (with ~15 ensureColumns + ~8 raw CREATE TABLE
// band-aids). After getBrainDb() routes through openDualScopeDb('project'), the
// brain domain is served from the consolidated `cleo.db`. See
// `establishLegacyBrainSchema` below for why the runtime keeps the LEGACY brain
// table shape during the E3→E6 transition.

/**
 * The set of brain-domain physical tables the T11363 consolidation migration
 * creates in the project `cleo.db`. Each is dropped + recreated in its LEGACY
 * runtime shape by {@link establishLegacyBrainSchema} (see that function for the
 * rationale). `deriver_queue` is included because the legacy `t1145` migration
 * creates it (unprefixed) and we must clear any prior shape first.
 *
 * @internal
 * @task T11522
 */
const CONSOLIDATED_BRAIN_TABLES = [
  'brain_attention',
  'brain_backfill_runs',
  'brain_consolidation_events',
  'brain_decisions',
  'brain_deriver_queue',
  'brain_embeddings',
  'brain_learnings',
  'brain_memory_links',
  'brain_memory_trees',
  'brain_modulators',
  'brain_observations',
  'brain_observations_staging',
  'brain_page_edges',
  'brain_page_nodes',
  'brain_patterns',
  'brain_plasticity_events',
  'brain_promotion_log',
  'brain_retrieval_log',
  'brain_schema_meta',
  'brain_session_narrative',
  'brain_sticky_notes',
  'brain_sticky_tags',
  'brain_transcript_events',
  'brain_usage_log',
  'brain_weight_history',
] as const;

/**
 * Detect whether the brain tables in the open handle carry the CONSOLIDATED
 * (exodus-target) shape rather than the LEGACY runtime shape.
 *
 * The consolidation migration (T11363) types `brain_attention.created_at` as
 * `text` (ISO-8601, with a GLOB CHECK constraint); the legacy runtime schema
 * (`memory-schema.ts`) types it as `integer` (epoch-ms, `unixepoch() * 1000`).
 * The column affinity is therefore a reliable, cheap discriminator.
 *
 * @internal
 * @task T11522
 */
function brainTablesAreConsolidatedShape(nativeDb: DatabaseSync): boolean {
  if (!tableExists(nativeDb, 'brain_attention')) return false;
  const cols = nativeDb.prepare('PRAGMA table_info(brain_attention)').all() as Array<{
    name: string;
    type: string;
  }>;
  const createdAt = cols.find((c) => c.name === 'created_at');
  // Legacy = INTEGER; consolidated target = TEXT. Anything non-INTEGER means we
  // are looking at the consolidated target shape and must rebuild to legacy.
  return createdAt !== undefined && createdAt.type.toUpperCase() !== 'INTEGER';
}

/**
 * Establish the LEGACY brain-domain schema inside the consolidated project
 * `cleo.db`, replacing the consolidated (exodus-target) brain tables.
 *
 * ## Why (T11522 · E6-L2)
 *
 * Routing `getBrainDb()` through {@link openDualScopeDb} runs the T11363
 * consolidation migration, which creates every `brain_*` table in its
 * **exodus-target** shape: ISO-8601 `text` timestamps and enum/format `CHECK`
 * constraints (e.g. `brain_attention.created_at GLOB '[0-9][0-9][0-9][0-9]-…'`,
 * `brain_page_nodes.node_type IN (…)`). The runtime brain writers and the
 * `brainSchema` (`memory-schema.ts`) still use the **legacy** shape — epoch-ms
 * `integer` timestamps and no enum CHECKs — exactly as the tasks domain keeps
 * using the legacy `tasks` table after E6-L1.
 *
 * Unlike tasks (legacy `tasks` ≠ consolidated `tasks_tasks`, so both co-exist),
 * the brain tables were already domain-prefixed, so legacy and consolidated
 * share the SAME physical names — they cannot co-exist. The runtime must win, so
 * on first open we drop the consolidated brain tables and run the legacy
 * `drizzle-brain` migrations to recreate them in the runtime shape. The
 * consolidated-target cutover (epoch→ISO conversion, CHECK constraints) is the
 * exodus's job — see T11248 / exodus-on-open T11553, which migrate the standalone
 * legacy `brain.db` into `cleo.db`.
 *
 * Idempotent: after the first rebuild the tables are already legacy-shaped, so
 * {@link brainTablesAreConsolidatedShape} returns `false` and this is a no-op
 * (the `drizzle-brain` journal is reconciled, nothing is dropped).
 *
 * @internal
 * @task T11522
 */
function establishLegacyBrainSchema(
  nativeDb: DatabaseSync,
  db: NodeSQLiteDatabase,
  dbPath: string,
): void {
  const log = getLogger('brain-schema');

  if (brainTablesAreConsolidatedShape(nativeDb)) {
    // Drop the consolidated (exodus-target) brain tables so the legacy
    // `drizzle-brain` migrations can recreate them in the runtime shape.
    // `brain_embeddings` is a vec0 virtual table once the extension is loaded;
    // DROP TABLE handles both regular and virtual tables when sqlite-vec is
    // present. Disable FKs during the drop so cross-table references do not
    // block the teardown — then RESTORE the prior pragma state (the dual-scope
    // pragma SSoT enables foreign_keys; leaving it OFF would break the
    // idempotent-pragma contract, T10314).
    const fkRow = nativeDb.prepare('PRAGMA foreign_keys').get() as
      | { foreign_keys?: number }
      | undefined;
    const fkWasOn = fkRow?.foreign_keys === 1;
    nativeDb.exec('PRAGMA foreign_keys=OFF');
    try {
      for (const table of CONSOLIDATED_BRAIN_TABLES) {
        try {
          nativeDb.exec(`DROP TABLE IF EXISTS \`${table}\``);
        } catch (err) {
          log.warn(
            { table, err },
            'Failed to drop consolidated brain table during legacy rebuild.',
          );
        }
      }
    } finally {
      // Restore the pragma to its pre-drop state (ON under the dual-scope SSoT).
      nativeDb.exec(`PRAGMA foreign_keys=${fkWasOn ? 'ON' : 'OFF'}`);
    }
    log.debug(
      { count: CONSOLIDATED_BRAIN_TABLES.length },
      'Dropped consolidated (exodus-target) brain tables — rebuilding in legacy runtime shape.',
    );
  }

  const migrationsFolder = resolveBrainMigrationsFolder();

  // T11647 — CONSOLIDATED `cleo.db` path. The consolidated `drizzle-cleo-project`
  // / `drizzle-cleo-global` migration already created every DOMAIN-PREFIXED
  // `brain_*` table in the LEGACY RUNTIME shape (the exodus target was aligned to
  // the runtime shape — see `cleo-shared/brain.ts`), so `brain_decisions` exists
  // and `brainTablesAreConsolidatedShape` is false (no DROP fired above). The
  // standalone `drizzle-brain` migrations must NOT be re-run wholesale: their
  // non-`IF NOT EXISTS` `CREATE TABLE`s / table-rebuilds for already-present
  // prefixed tables (e.g. `brain_observations_staging`) and their ALTER-ADD-COLUMN
  // for already-present columns would collide.
  if (tableExists(nativeDb, 'brain_decisions') && !brainTablesAreConsolidatedShape(nativeDb)) {
    // Additive reconcile-and-apply: for each not-yet-journaled `drizzle-brain`
    // migration, mark-applied-without-running when its net effect is already
    // present (the prefixed `brain_*` tables + their final columns the
    // consolidated migration created), else exec it directly (the UNPREFIXED
    // runtime tables `deriver_queue`/`sticky_tags`/`session_narrative`/
    // `brain_task_observations` the consolidated migration omits but the runtime
    // queries). This NEVER deletes a journal row and never engages drizzle's
    // shared-handle transaction, so it cannot corrupt the tasks-domain journal
    // entries that share this consolidated `cleo.db`'s `__drizzle_migrations` —
    // see reconcileBrainMigrationsForConsolidatedDb for the full rationale. The
    // exodus-migrated rows in the prefixed tables survive untouched (the
    // data-loss fix).
    const { marked, applied } = reconcileBrainMigrationsForConsolidatedDb(
      nativeDb,
      migrationsFolder,
    );
    log.debug(
      { marked, applied },
      'brain consolidated cleo.db reconcile (T11647) — marked already-present migrations applied + executed the missing unprefixed-table migrations directly.',
    );
    return;
  }

  // LEGACY standalone `brain.db` (or brand-new DB) path: no prefixed brain tables
  // pre-created, so run the full `drizzle-brain` migrate via the generic
  // reconcile (its Scenario-2 orphan-delete is safe here — a standalone brain.db
  // journal contains only brain hashes).
  // `dbPath` is passed explicitly (T12038) — it used to be read from the
  // module-global `_dbPath`, which was still `null` on the first open because
  // it was assigned AFTER this reconcile ran, so the safety backup never fired
  // on the very path that needed it.
  if (tableExists(nativeDb, 'brain_decisions')) {
    createSafetyBackup(dbPath);
  }
  reconcileJournal(nativeDb, migrationsFolder, 'brain_decisions', 'brain');
  migrateWithRetry(db, migrationsFolder, nativeDb, 'brain_decisions', 'brain');
  // The `drizzle-brain` set now includes `brain_task_observations` (T1615) via
  // the forward migration `20260601000001_t11522-brain-task-observations`, so the
  // previous post-hoc `CREATE TABLE IF NOT EXISTS` band-aid for it is no longer
  // needed here (T11522 AC: post-hoc DDL → forward Drizzle migration).
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
 * Check whether the `sqlite-vec` extension is loaded for a project's brain
 * database.
 *
 * ## E6-L14 (T12038) — now per-database
 *
 * This used to read a single process-wide boolean, so a project whose vec
 * extension failed to load could report `true` because a DIFFERENT project
 * had loaded it. The flag is now per-binding.
 *
 * Returns `false` when the brain domain is not bound for `cwd` yet — callers
 * must `await getBrainDb(cwd)` / {@link bindBrainDomain} first.
 *
 * @param cwd - Project working directory. Defaults to the ambient project.
 */
export function isBrainVecLoaded(cwd?: string): boolean {
  return peekProjectDomain<BrainDomainHandle>('brain', cwd)?.db.vecLoaded ?? false;
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
 * Initialize the project-scope BRAIN domain SQLite database (lazy, singleton).
 *
 * ## E6-L2 façade (T11522)
 *
 * Delegates the physical DB open to {@link openDualScopeDb}('project', cwd) —
 * the canonical dual-scope chokepoint. The returned `NodeSQLiteDatabase` wraps
 * the same `DatabaseSync` handle as the consolidated project `cleo.db` but is
 * typed against the legacy brain schema (`brainSchema`, physical tables
 * `brain_decisions`, …) so all existing brain callers compile and run without
 * change. The legacy `drizzle-brain` migrations are still applied to this handle
 * during the E3→E6 transition (additive / `IF NOT EXISTS` — idempotent on the
 * consolidated DB) so the runtime-queried legacy physical tables (notably
 * `deriver_queue`) co-exist with the consolidated `brain_*` tables.
 *
 * Brain-specific malformation auto-recovery (T10303 / Saga T10281) previously
 * ran here against the standalone `brain.db` file. That file no longer backs the
 * brain domain after this leaf — the brain tables live inside `cleo.db`, whose
 * malformation recovery is a dual-scope-level concern (the brain-only
 * quarantine/snapshot-restore pipeline would corrupt the co-resident `tasks_*` /
 * `conduit_*` domains). The recovery primitive itself (`recoverMalformedBrainDb`)
 * is retained for `doctor` use; only its wiring into this chokepoint is removed.
 *
 * Uses a promise guard so concurrent callers wait for the same initialization to
 * complete (migrations are async).
 */
export async function getBrainDb(cwd?: string): Promise<NodeSQLiteDatabase> {
  return (await bindBrainDomain(cwd)).db.drizzle;
}

/**
 * Bind the legacy brain schema to the {@link ProjectStore} for `cwd` and
 * return the full binding (store + native handle + {@link BrainDomainHandle}).
 *
 * ## E6-L14 cutover (T12038)
 *
 * The ProjectStore-bound typed port that replaces this module's singleton
 * quintet (`_db` / `_nativeDb` / `_dbPath` / `_initPromise` / `_vecLoaded`).
 *
 * The brain domain shares ONE `DatabaseSync` with the tasks domain (both are
 * tables inside the same consolidated `cleo.db`). Under the old design that
 * sharing was implicit and fragile: the tasks side could close the connection
 * while the brain singleton still referenced it, and `observeBrain`'s
 * cross-domain write-guard swallowed the resulting `database is not open` as
 * "session absent" — silently nulling `sourceSessionId` (T12019/T12020).
 * Binding both domains to the SAME store instance makes the sharing explicit:
 * an eviction invalidates both bindings at once, by identity.
 *
 * Prefer this over {@link getBrainDb} when you also need the native handle,
 * the per-database vec flag, or an explicit store for a cross-domain
 * transaction with the tasks domain.
 *
 * @param cwd - Project working directory.
 * @returns The live brain-domain binding.
 *
 * @task T12038 (E6-L14)
 */
export async function bindBrainDomain(
  cwd?: string,
): Promise<DomainBinding<BrainDomainHandle, ProjectStore>> {
  // T1906: guard against prod-DB writes in test mode.
  const { assertTestEnv } = await import('./data-accessor.js');
  assertTestEnv(getBrainDbPath(cwd));

  return bindProjectDomain('brain', cwd, (nativeDb, store) => {
    // Load the sqlite-vec extension for vector similarity search (T5157). The
    // dual-scope handle is opened with `allowExtension: true`, so loading is
    // permitted. Non-fatal if unavailable — vec0 tables simply won't be created.
    const vecLoaded = loadBrainVecExtension(nativeDb);

    // Wrap the native handle with the legacy brain-schema drizzle instance so
    // existing callers (brainSchema.* queries) continue to work unchanged.
    const drizzle = _getDrizzle()({ client: nativeDb });

    // Reconcile the LEGACY brain-domain schema inside the consolidated cleo.db.
    // Since T11647 the consolidated `cleo.db` migration already creates every
    // `brain_*` table in the LEGACY RUNTIME shape (epoch-ms integer timestamps,
    // no SQL CHECK constraints — the exodus target was aligned to the runtime
    // shape in `cleo-shared/brain.ts`). So this is now a no-op reconcile: it
    // marks the `drizzle-brain` lineage applied and skips the migrate, leaving
    // any exodus-migrated brain rows intact. The legacy standalone-`brain.db`
    // path (DB with no consolidated brain tables) still runs the full
    // `drizzle-brain` migrate. The pre-T11647 DROP+recreate path is retained as
    // a defensive fallback for any DB still carrying the old consolidated shape.
    // (T11522 · T11647)
    establishLegacyBrainSchema(nativeDb, drizzle, store.dbPath);

    // T12535: bring the prefixed twins (brain_sticky_tags among them) up to
    // date with their bare tables before the accessor reads them. A no-op when
    // the tasks bind already did it in this open.
    collapseTwinTables(nativeDb, store.dbPath);

    // Create the vec0 virtual table for embeddings if the extension is loaded
    // (T5157). Must run after migrations so the schema is consistent.
    if (vecLoaded) {
      initializeBrainVec(nativeDb);
    }

    // Seed schema version for new databases (no-op if already set).
    nativeDb
      .prepare(
        `INSERT OR IGNORE INTO brain_schema_meta (key, value) VALUES ('schemaVersion', '${BRAIN_SCHEMA_VERSION}')`,
      )
      .run();

    // Wire the default embedding provider when vec is loaded and embedding is
    // enabled. Best-effort, async, never blocks DB access. (T539)
    if (vecLoaded) {
      setImmediate(() => {
        initEmbeddingProvider(cwd).catch(() => {
          // Non-fatal — embedding will be unavailable until next startup.
        });
      });
    }

    return { drizzle, vecLoaded };
  });
}

/**
 * Close the brain-domain database connection and release resources.
 *
 * ## E6-L2 (T11522)
 *
 * The brain domain now SHARES the consolidated project `cleo.db` handle with the
 * tasks domain (both open it via {@link openDualScopeDb}, same cache key). This
 * function therefore must NOT close the underlying `DatabaseSync` nor evict the
 * dual-scope cache — doing so would break in-flight tasks-domain queries with
 * "database is not open". It only drops the brain-domain singleton references;
 * the shared handle's lifecycle is owned by `openDualScopeDb` and torn down by a
 * coordinated reset (`closeAllDatabases` → `closeDb` → `_resetDualScopeDbCache`).
 */
export function closeBrainDb(): void {
  // Drop only the brain-domain binding. Do NOT close the connection — it is
  // the shared dual-scope handle, possibly still in use by the tasks domain.
  releaseDomainBindings({ scope: 'project', domain: 'brain' });
}

/**
 * Reset brain-domain singleton state without saving.
 * Used during tests or when the database file is recreated.
 * Safe to call multiple times.
 *
 * ## E6-L2 (T11522)
 *
 * Drops only the brain-domain singleton references — does NOT close the shared
 * dual-scope `cleo.db` handle nor evict the dual-scope cache (that handle is
 * shared with the tasks domain). Mirrors {@link closeBrainDb}.
 */
export function resetBrainDbState(): void {
  releaseDomainBindings({ scope: 'project', domain: 'brain' });
}

/**
 * Get the underlying node:sqlite DatabaseSync instance for brain.db.
 * Useful for direct PRAGMA calls or raw SQL operations.
 * Returns null if the database hasn't been initialized.
 */
export function getBrainNativeDb(cwd?: string): DatabaseSync | null {
  return boundProjectNative('brain', cwd);
}

export type { NodeSQLiteDatabase };
/**
 * Re-export brain schema for external use.
 */
export { brainSchema };
