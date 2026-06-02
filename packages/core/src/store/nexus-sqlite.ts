/**
 * SQLite store for the NEXUS domain via drizzle-orm/node-sqlite + node:sqlite
 * (DatabaseSync).
 *
 * ## Dual-scope residency split (ADR-090 · T11648 — runtime read half)
 *
 * The nexus domain is now SPLIT across the two consolidated `cleo.db` files:
 *
 * - **GRAPH (project scope):** the four code-graph tables (`nexus_nodes`,
 *   `nexus_relations`, `nexus_contracts`, `nexus_code_index`) + the
 *   `nexus_relation_weights` plasticity sibling live in
 *   `<projectRoot>/.cleo/cleo.db` — the portable per-project living brain.
 *   This is where exodus WRITES them (`resolveTableTargetScope` in
 *   `store/exodus/table-name-map.ts`), so the runtime READS them from there too.
 * - **REGISTRY/identity (global scope):** the six cross-project tables
 *   (`nexus_project_registry`, `nexus_project_id_aliases`, `nexus_user_profile`,
 *   `nexus_sigils`, `nexus_audit_log`, `nexus_schema_meta`) stay in the GLOBAL
 *   `cleo.db` under {@link getCleoHome} (ADR-090 §2.2).
 *
 * `getNexusDb()` opens the PROJECT scope as `main` (via {@link openDualScopeDb}
 * ('project')) and ATTACHes the GLOBAL `cleo.db` under
 * {@link NEXUS_GLOBAL_ATTACH_ALIAS}. SQLite's bare-name resolution then routes
 * each query to the correct file with ZERO accessor changes: graph tables exist
 * in `main` (project) and resolve there; registry/identity tables are absent
 * from `main` and fall through to the attached GLOBAL db. The GLOBAL db also
 * carries empty graph tables (frozen T11363 migration leftovers), correctly
 * SHADOWED by `main`.
 *
 * ### Why this fix (T11648)
 *
 * T11538/T11539 moved the graph schema to PROJECT scope and routed exodus there,
 * but the runtime READ accessors still opened the GLOBAL handle — so after a
 * `cleo exodus migrate` the project held 24k+ `nexus_nodes` while the runtime
 * read 0 from global (`cleo nexus search-code` / `context` returned empty). This
 * module is the deferred runtime half: it reads the graph from the SAME scope
 * exodus writes it.
 *
 * This preserves the prior guarantees:
 * - Every nexus-domain open flows through the single pragma SSoT (ADR-068/069).
 * - DB Open Guard Gate 3 (`scripts/lint-no-direct-db-open.mjs`) stays green: the
 *   only native open is inside `dual-scope-db.ts` (the ATTACH below is a SQL
 *   statement on an already-chokepointed handle, not a `new DatabaseSync(`).
 *
 * ## COMPLETE-CUTOVER to prefixed `nexus_*` tables (T11578 · AC3)
 *
 * The nexus runtime READ + WRITE path targets PREFIXED consolidated tables. The
 * five PROJECT graph tables are owned by the consolidated cleo-project migration;
 * the six GLOBAL registry/identity tables by the consolidated cleo-global
 * migration. The former legacy drop/rebuild (`establishLegacyNexusSchema`) and
 * BARE registry tables (`project_registry`, …) are GONE. The runtime schema
 * barrel `schema/nexus-schema.ts` maps every export symbol to its prefixed
 * physical name — accessors need ZERO change.
 *
 * The `drizzle-nexus` migration set carries ONLY the delta the consolidated
 * migration cannot model: the `nexus_symbols_fts` FTS5 virtual table + its three
 * `nexus_nodes` triggers, the `nexus_relation_weights` plasticity-partition
 * sibling (T11545), and the `_nexus_meta` health-probe table (the reconcile
 * sentinel). The destructive half of the plasticity partition is applied
 * idempotently at open by `ensureNexusRelationWeights` (a no-op for the
 * already-narrow project-scope `nexus_relations`).
 *
 * @adr ADR-036 — registry/identity is global-only (relaxed for the 4 graph
 *   tables by ADR-090 §2.4).
 * @adr ADR-090 — nexus code-graph residency global→project scope split.
 * @task T5365
 * @task T11524 - E6-L4: route getNexusDb through the dual-scope chokepoint
 * @task T11578 - AC3: COMPLETE-CUTOVER nexus runtime → prefixed nexus_* tables
 * @task T11648 - ADR-090 runtime read half: route graph reads to project scope
 */

import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { getLogger } from '../logger.js';
import { getCleoHome } from '../paths.js';
// E6-L4 (T11524): dual-scope chokepoint — the nexus domain now opens the
// consolidated GLOBAL `cleo.db` through here. openDualScopeDb manages the
// DatabaseSync lifecycle, pragmas, and consolidated migrations. We extract the
// native handle and re-wrap it with the legacy nexus-schema drizzle instance so
// existing callers (nexusSchema.* queries) compile and run without change.
import { openDualScopeDb, resolveDualScopeDbPath } from './dual-scope-db.js';
import { ensureColumns, migrateWithRetry, reconcileJournal } from './migration-manager.js';
import { resolveCorePackageMigrationsFolder } from './resolve-migrations-folder.js';
import * as nexusSchema from './schema/nexus-schema.js';
// isSqliteBusy is a pure predicate with no node:sqlite dependency — import it
// from its canonical leaf home (with-retry.ts) rather than sqlite.ts so this
// module no longer pulls the native open path.
import { isSqliteBusy } from './with-retry.js';

/** Schema version for newly created nexus databases. Single source of truth. */
export const NEXUS_SCHEMA_VERSION = '1.0.0';

/** Singleton state for lazy initialization. */
let _nexusDb: NodeSQLiteDatabase<typeof nexusSchema> | null = null;
let _nexusNativeDb: DatabaseSync | null = null;
let _nexusDbPath: string | null = null;
/** Guard against concurrent initialization (async migration). */
let _nexusInitPromise: Promise<NodeSQLiteDatabase<typeof nexusSchema>> | null = null;

/**
 * SQLite ATTACH alias under which the GLOBAL consolidated `cleo.db` is mounted
 * into the PROJECT-scope nexus handle so the cross-project registry/identity
 * tables (`nexus_project_registry`, `nexus_user_profile`, `nexus_sigils`,
 * `nexus_project_id_aliases`, `nexus_audit_log`, `nexus_schema_meta`) stay
 * reachable by their BARE names (ADR-090 · T11648).
 *
 * SQLite resolves a bare table name against `main` first, then attached
 * databases in attach order. The PROJECT `cleo.db` (`main`) physically carries
 * ONLY the five graph tables (`nexus_nodes`, `nexus_relations`,
 * `nexus_contracts`, `nexus_code_index`, `nexus_relation_weights`), so those
 * bare names resolve to the populated project graph; the registry/identity
 * tables — absent from `main` — fall through to this attached GLOBAL db. The
 * GLOBAL db ALSO carries empty graph tables (frozen T11363 migration leftovers),
 * but those are correctly SHADOWED by `main` and never read or written.
 */
const NEXUS_GLOBAL_ATTACH_ALIAS = 'nexus_global';

/**
 * Returns the nexus GRAPH DB path — the consolidated PROJECT `cleo.db`
 * (`<projectRoot>/.cleo/cleo.db`), where the four code-graph tables
 * (`nexus_nodes`, `nexus_relations`, `nexus_contracts`, `nexus_code_index`) and
 * the `nexus_relation_weights` plasticity sibling physically reside post the
 * ADR-090 residency split (T11538/T11539).
 *
 * ## ADR-090 residency move — runtime read half (T11648)
 *
 * Exodus WRITES the graph tables to PROJECT scope (per `resolveTableTargetScope`
 * in `store/exodus/table-name-map.ts`); this resolver routes the runtime READ
 * path to the SAME scope so the migrated graph is visible. Previously this
 * returned the GLOBAL `cleo.db` (`resolveDualScopeDbPath('global')`), which left
 * `cleo nexus search-code` / `context` reading the empty global graph tables —
 * the T11538/T11539 runtime-half gap this fix closes. The cross-project
 * registry/identity tables stay GLOBAL and are reached via the
 * {@link NEXUS_GLOBAL_ATTACH_ALIAS} attach (see {@link getNexusRegistryDbPath}).
 *
 * @param cwd - Optional working directory used to resolve the owning project
 *   root (forwarded to {@link resolveDualScopeDbPath}('project', cwd)).
 * @task T307
 * @epic T299
 * @task T11648 (ADR-090 runtime read half — route graph reads to project scope)
 * @why ADR-090 §2.1/§2.4 supersedes ADR-036's global-only assertion FOR THE
 *   GRAPH TABLES ONLY. The graph is per-project and must live in the portable
 *   `.cleo/cleo.db`; the registry/identity tables remain global-asserted in
 *   {@link getNexusRegistryDbPath}.
 */
export function getNexusDbPath(cwd?: string): string {
  return resolveDualScopeDbPath('project', cwd);
}

/**
 * Returns the cross-project nexus REGISTRY/identity DB path — the consolidated
 * GLOBAL `cleo.db` under `getCleoHome()`.
 *
 * The registry/identity tables (`nexus_project_registry`,
 * `nexus_project_id_aliases`, `nexus_user_profile`, `nexus_sigils`,
 * `nexus_audit_log`, `nexus_schema_meta`) are genuinely global (ADR-090 §2.2)
 * and MUST stay under `getCleoHome()`. The ADR-036 global-only assertion is
 * retained here as defence-in-depth (it was relaxed only for the four graph
 * tables, now homed in PROJECT scope via {@link getNexusDbPath}).
 *
 * @task T11648 (ADR-090 — registry stays global-asserted)
 * @adr ADR-036 — registry/identity is global-only.
 * @throws {Error} If the resolved path is not under `getCleoHome()`.
 */
export function getNexusRegistryDbPath(): string {
  const cleoHome = getCleoHome();
  const registryPath = resolveDualScopeDbPath('global');

  // Guard: the registry/identity home MUST be under the global tier (ADR-036).
  if (!registryPath.startsWith(cleoHome)) {
    throw new Error(
      `BUG: getNexusRegistryDbPath() resolved to "${registryPath}" which is NOT ` +
        `under getCleoHome() ("${cleoHome}"). The nexus registry/identity tables ` +
        `are global-only per ADR-036/ADR-090 §2.2. This indicates a code path that ` +
        `bypasses canonical path resolution — fix the caller, do not suppress this error.`,
    );
  }

  return registryPath;
}

/**
 * Idempotently ATTACH the GLOBAL consolidated `cleo.db` into a PROJECT-scope
 * nexus handle under {@link NEXUS_GLOBAL_ATTACH_ALIAS}, so the cross-project
 * registry/identity tables resolve by their bare names (ADR-090 · T11648).
 *
 * Safe to call repeatedly: if the alias is already attached (a sibling domain
 * opened the same shared project handle first, or a prior nexus open ran this),
 * the duplicate `ATTACH` throws and is swallowed. The global `cleo.db` is the
 * canonical registry home; we ensure its directory exists via the global open
 * resolver before attaching.
 *
 * @param nativeDb - The open PROJECT-scope `DatabaseSync` handle.
 * @task T11648
 */
function ensureGlobalRegistryAttached(nativeDb: DatabaseSync): void {
  const globalPath = getNexusRegistryDbPath();
  const escaped = globalPath.replace(/'/g, "''");

  // Inspect the current attach (if any). `PRAGMA database_list` reports the alias
  // + the file each schema is bound to. The registry home is resolved fresh from
  // `getNexusRegistryDbPath()` (which reads `getCleoHome()`), so it can change
  // between opens — e.g. tests that mutate `CLEO_HOME` while sharing the cwd-keyed
  // project handle, or a sibling domain that re-opened the shared project DB. A
  // stale ATTACH would silently read a prior registry. To stay deterministic we
  // DETACH any existing `nexus_global` (unless it is provably the same file) and
  // re-ATTACH the current registry path.
  const existing = (
    nativeDb.prepare('PRAGMA database_list').all() as Array<{ name?: string; file?: string }>
  ).find((row) => row.name === NEXUS_GLOBAL_ATTACH_ALIAS);

  if (existing) {
    // Fast path: the alias is already bound to exactly the current registry file.
    if (existing.file === globalPath) return;
    // Otherwise re-bind. DETACH is best-effort; the subsequent ATTACH surfaces a
    // clear error rather than silently leaving a stale binding.
    try {
      nativeDb.exec(`DETACH DATABASE ${NEXUS_GLOBAL_ATTACH_ALIAS}`);
    } catch {
      // Alias still bound (e.g. an open statement) — the ATTACH below would throw
      // "database nexus_global is already in use"; treat the existing binding as
      // authoritative only when its file matches, which we already returned for.
      return;
    }
  }

  // The global cleo.db is created/migrated by the global dual-scope open path
  // (sibling domains: skills/agent-registry/global-brain). ATTACH only needs the
  // file to exist; SQLite creates it if absent, but it will then lack the
  // consolidated registry schema. Registry readers tolerate a missing table
  // (try/catch), so a bare ATTACH is sufficient and non-fatal here.
  nativeDb.exec(`ATTACH DATABASE '${escaped}' AS ${NEXUS_GLOBAL_ATTACH_ALIAS}`);
}

/**
 * Resolve the absolute path to the drizzle-nexus migrations folder inside
 * @cleocode/core, using ESM-native module resolution (T1177).
 *
 * Delegates to {@link resolveCorePackageMigrationsFolder} which handles
 * bundled dist/, workspace dev, and global-install layouts uniformly via
 * `import.meta.resolve()` + `createRequire().resolve()` fallback.
 */
export function resolveNexusMigrationsFolder(): string {
  return resolveCorePackageMigrationsFolder('drizzle-nexus');
}

// ---------------------------------------------------------------------------
// Nested-nexus migration debris detection (ADR-086 / T10321)
// ---------------------------------------------------------------------------

/**
 * Canonical filename within the nested `<cleoHome>/nexus/` subdirectory that
 * indicates the structural bug ADR-086 BANs. If this file exists, the install
 * has not yet run `scripts/migrate-nested-nexus.mjs`.
 */
const NESTED_NEXUS_SENTINEL = 'nexus.db';

/**
 * One-shot warning gate keyed on the absolute nested path. Prevents the
 * warning from spamming when `getNexusDb()` is called repeatedly within a
 * single process (e.g. CLI commands that re-open the handle, tests that
 * exercise nexus across many describe blocks).
 *
 * Exposed via {@link _resetNestedNexusWarningGate} for test hygiene.
 */
const _warnedNestedPaths: Set<string> = new Set();

/**
 * Returns the absolute path that, if present, indicates the install carries
 * the nested-nexus structural bug. ALWAYS `<cleoHome>/nexus/nexus.db`.
 *
 * Exposed for tests; production callers should use
 * {@link detectAndWarnOnNestedNexus} instead.
 *
 * @task T10321
 * @adr ADR-086
 */
export function getNestedNexusSentinelPath(): string {
  return join(getCleoHome(), 'nexus', NESTED_NEXUS_SENTINEL);
}

/**
 * Detect the presence of the nested-nexus structural bug and emit a one-shot
 * warning via the canonical pino logger if found.
 *
 * The function is non-blocking and non-throwing — it never alters the
 * outcome of the surrounding `getNexusDb()` open. The canonical consolidated
 * open proceeds normally regardless of whether the nested debris is present.
 *
 * Idempotency: the first call for a given nested path emits the warning;
 * subsequent calls within the same process are no-ops. Tests can reset the
 * gate via {@link _resetNestedNexusWarningGate}.
 *
 * @returns `true` when the warning fired on this call; `false` otherwise.
 *
 * @task T10321
 * @adr ADR-086
 */
export function detectAndWarnOnNestedNexus(): boolean {
  let nestedPath: string;
  try {
    nestedPath = getNestedNexusSentinelPath();
  } catch {
    // Path resolution should never throw, but defence-in-depth: if it does
    // we silently skip — never break the open path for a diagnostic warning.
    return false;
  }

  if (!existsSync(nestedPath)) return false;
  if (_warnedNestedPaths.has(nestedPath)) return false;
  _warnedNestedPaths.add(nestedPath);

  const canonicalPath = getNexusDbPath();
  const log = getLogger('nexus-sqlite');
  log.warn(
    {
      nestedPath,
      canonicalPath,
      migrationCommand: 'node scripts/migrate-nested-nexus.mjs',
      adr: 'ADR-086',
      task: 'T10321',
    },
    'Detected nested-nexus structural bug — canonical consolidated cleo.db is in use; ' +
      'nested duplicates at <cleoHome>/nexus/ are migration debris. Run the ' +
      'migration script to remove them.',
  );

  return true;
}

/**
 * Reset the one-shot warning gate. Tests only — production callers MUST NOT
 * use this.
 *
 * @internal
 * @task T10321
 */
export function _resetNestedNexusWarningGate(): void {
  _warnedNestedPaths.clear();
}

/**
 * Check whether a table exists in the SQLite database.
 */
function tableExists(nativeDb: DatabaseSync, tableName: string): boolean {
  const result = nativeDb
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(tableName) as Record<string, unknown> | undefined;
  return !!result;
}

/**
 * Check whether a virtual table (or any object) exists in the SQLite database.
 *
 * sqlite_master covers virtual tables, triggers, and regular tables alike.
 */
function objectExists(nativeDb: DatabaseSync, type: string, name: string): boolean {
  const result = nativeDb
    .prepare('SELECT name FROM sqlite_master WHERE type=? AND name=?')
    .get(type, name) as Record<string, unknown> | undefined;
  return !!result;
}

/**
 * Idempotent FTS5 setup for nexus_symbols_fts (T1839).
 *
 * Creates the FTS5 virtual table indexed on label + file_path, installs the
 * three nexus_nodes triggers (INSERT/UPDATE/DELETE), and backfills any existing
 * nexus_nodes rows that are not yet represented in the FTS5 table.
 *
 * Called before drizzle migrations so existing DBs are covered. Each DDL
 * statement is guarded by IF NOT EXISTS / DROP IF EXISTS — safe to re-run.
 *
 * Uses nativeDb.exec() (not prepare().run()) to avoid the node:sqlite
 * first-statement-only limitation.
 *
 * @task T1839
 */
function ensureNexusFts5(nativeDb: DatabaseSync): void {
  // Only run if nexus_nodes exists (it is populated before FTS5 is useful).
  if (!tableExists(nativeDb, 'nexus_nodes')) return;

  // 1. FTS5 virtual table — skip if already present.
  if (!objectExists(nativeDb, 'table', 'nexus_symbols_fts')) {
    nativeDb.exec(`
      CREATE VIRTUAL TABLE nexus_symbols_fts USING fts5(
        node_id UNINDEXED,
        label,
        file_path,
        tokenize = 'unicode61 remove_diacritics 1'
      )
    `);
  }

  // 2. INSERT trigger.
  nativeDb.exec(`DROP TRIGGER IF EXISTS nexus_nodes_fts_ai`);
  nativeDb.exec(`
    CREATE TRIGGER nexus_nodes_fts_ai
    AFTER INSERT ON nexus_nodes
    BEGIN
      INSERT INTO nexus_symbols_fts(rowid, node_id, label, file_path)
      VALUES (new.rowid, new.id, new.label, new.file_path);
    END
  `);

  // 3. DELETE trigger.
  // Note: node:sqlite does not support the FTS5 content-table delete syntax
  // `INSERT INTO fts(fts, rowid, ...) VALUES ('delete', ...)`.
  // Instead, a plain `DELETE FROM nexus_symbols_fts WHERE rowid = old.rowid`
  // removes the row from the FTS5 index reliably across all supported SQLite versions.
  nativeDb.exec(`DROP TRIGGER IF EXISTS nexus_nodes_fts_ad`);
  nativeDb.exec(`
    CREATE TRIGGER nexus_nodes_fts_ad
    AFTER DELETE ON nexus_nodes
    BEGIN
      DELETE FROM nexus_symbols_fts WHERE rowid = old.rowid;
    END
  `);

  // 4. UPDATE trigger — delete old entry then insert new one.
  nativeDb.exec(`DROP TRIGGER IF EXISTS nexus_nodes_fts_au`);
  nativeDb.exec(`
    CREATE TRIGGER nexus_nodes_fts_au
    AFTER UPDATE ON nexus_nodes
    BEGIN
      DELETE FROM nexus_symbols_fts WHERE rowid = old.rowid;
      INSERT INTO nexus_symbols_fts(rowid, node_id, label, file_path)
      VALUES (new.rowid, new.id, new.label, new.file_path);
    END
  `);

  // 5. Backfill existing nexus_nodes rows not yet in the FTS5 table.
  // The NOT IN guard makes this idempotent across repeated calls.
  nativeDb.exec(`
    INSERT INTO nexus_symbols_fts(rowid, node_id, label, file_path)
    SELECT rowid, id, label, file_path
    FROM nexus_nodes
    WHERE rowid NOT IN (SELECT rowid FROM nexus_symbols_fts)
  `);
}

/**
 * Idempotent safety net + partition completer for `nexus_relation_weights`
 * (T11545 · ADR-090 §5.3 · T11578 · AC3).
 *
 * The Hebbian plasticity columns were partitioned out of `nexus_relations` into
 * this sibling 1:1 table. After the AC3 cutover the consolidated cleo-global
 * migration (T11363) owns `nexus_relations` but still creates it with the THREE
 * inline plasticity columns (`weight`, `last_accessed_at`, `co_accessed_count`)
 * — the T11363 shape predates the partition. This safety net completes the
 * partition idempotently at runtime (the destructive column-DROP is kept OUT of
 * the journaled migration SQL, where re-runs would throw):
 *
 *   1. CREATE the sibling table (+ indexes) — covers fresh + pre-partition DBs.
 *   2. When the inline columns are still present on `nexus_relations`, BACKFILL
 *      any non-default plasticity state into the sibling table so no weights are
 *      lost, then DROP the three inline columns so the structural graph row is
 *      narrow (matching `nexus-schema.ts` + the must-pass fresh-init test).
 *
 * Every statement is guarded by IF-NOT-EXISTS / column-presence probes; safe to
 * re-run on every open (the DROP only fires while the inline columns exist).
 *
 * @task T11545
 * @task T11578
 */
function ensureNexusRelationWeights(nativeDb: DatabaseSync): void {
  // Only meaningful once the parent graph table exists.
  if (!tableExists(nativeDb, 'nexus_relations')) return;

  nativeDb.exec(`
    CREATE TABLE IF NOT EXISTS nexus_relation_weights (
      relation_id       TEXT PRIMARY KEY NOT NULL,
      weight            REAL DEFAULT 0.0 NOT NULL,
      last_accessed_at  TEXT,
      co_accessed_count INTEGER DEFAULT 0 NOT NULL
    )
  `);
  nativeDb.exec(
    `CREATE INDEX IF NOT EXISTS idx_nexus_relation_weights_last_accessed ON nexus_relation_weights (last_accessed_at)`,
  );
  nativeDb.exec(
    `CREATE INDEX IF NOT EXISTS idx_nexus_relation_weights_weight ON nexus_relation_weights (weight)`,
  );

  // Detect the inline plasticity columns the consolidated T11363 `nexus_relations`
  // still carries. When absent, the partition is already complete — nothing to do.
  const relCols = nativeDb.prepare('PRAGMA table_info(nexus_relations)').all() as Array<{
    name: string;
  }>;
  const hasInlinePlasticity = relCols.some((c) => c.name === 'weight');
  if (!hasInlinePlasticity) return;

  // Backfill any non-default plasticity state before dropping the columns
  // (pristine rows are intentionally NOT copied — absence == weight 0.0).
  nativeDb.exec(`
    INSERT OR IGNORE INTO nexus_relation_weights (relation_id, weight, last_accessed_at, co_accessed_count)
    SELECT id, COALESCE(weight, 0.0), last_accessed_at, COALESCE(co_accessed_count, 0)
      FROM nexus_relations
     WHERE COALESCE(weight, 0.0) > 0.0
        OR last_accessed_at IS NOT NULL
        OR COALESCE(co_accessed_count, 0) > 0
  `);

  // Complete the partition: rebuild `nexus_relations` to the narrow structural
  // shape (T11578 · AC3). A plain `ALTER TABLE ... DROP COLUMN last_accessed_at`
  // is REJECTED by SQLite because the consolidated T11363 table carries
  // `CHECK ("last_accessed_at" GLOB …)` — a column referenced by a CHECK cannot
  // be dropped without a full table rebuild (the T11545 migration note). So we
  // CREATE the narrow table, copy the structural columns, drop the old table, and
  // rename. The `type`/`indexed_at` CHECKs + indexes are preserved; only the three
  // plasticity columns + their CHECK + the plasticity index are removed.
  //
  // The FTS triggers fire on `nexus_nodes` (not `nexus_relations`), so they are
  // unaffected. FKs are disabled for the rebuild then restored to the dual-scope
  // SSoT state (T10314 idempotent-pragma contract).
  const fkRow = nativeDb.prepare('PRAGMA foreign_keys').get() as
    | { foreign_keys?: number }
    | undefined;
  const fkWasOn = fkRow?.foreign_keys === 1;
  nativeDb.exec('PRAGMA foreign_keys=OFF');
  try {
    nativeDb.exec('DROP INDEX IF EXISTS idx_nexus_relations_last_accessed');
    nativeDb.exec(`
      CREATE TABLE nexus_relations__narrow (
        id text PRIMARY KEY,
        project_id text NOT NULL,
        source_id text NOT NULL,
        target_id text NOT NULL,
        type text NOT NULL,
        confidence real NOT NULL,
        reason text,
        step integer,
        indexed_at text DEFAULT (datetime('now')) NOT NULL,
        CHECK ("type" IN ('contains', 'defines', 'imports', 'accesses', 'calls', 'extends', 'implements', 'method_overrides', 'method_implements', 'has_method', 'has_property', 'member_of', 'step_in_process', 'handles_route', 'fetches', 'handles_tool', 'entry_point_of', 'wraps', 'queries', 'documents', 'applies_to', 'co_changed', 'co_cited_in_task')),
        CHECK ("indexed_at" IS NULL OR "indexed_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
      )
    `);
    nativeDb.exec(`
      INSERT INTO nexus_relations__narrow
        (id, project_id, source_id, target_id, type, confidence, reason, step, indexed_at)
      SELECT id, project_id, source_id, target_id, type, confidence, reason, step, indexed_at
        FROM nexus_relations
    `);
    nativeDb.exec('DROP TABLE nexus_relations');
    nativeDb.exec('ALTER TABLE nexus_relations__narrow RENAME TO nexus_relations');
    // Recreate the structural indexes the rebuild dropped (match T11363 names).
    nativeDb.exec(
      'CREATE INDEX IF NOT EXISTS idx_nexus_relations_project ON nexus_relations (project_id)',
    );
    nativeDb.exec(
      'CREATE INDEX IF NOT EXISTS idx_nexus_relations_source ON nexus_relations (source_id)',
    );
    nativeDb.exec(
      'CREATE INDEX IF NOT EXISTS idx_nexus_relations_target ON nexus_relations (target_id)',
    );
    nativeDb.exec('CREATE INDEX IF NOT EXISTS idx_nexus_relations_type ON nexus_relations (type)');
    nativeDb.exec(
      'CREATE INDEX IF NOT EXISTS idx_nexus_relations_project_type ON nexus_relations (project_id, type)',
    );
    nativeDb.exec(
      'CREATE INDEX IF NOT EXISTS idx_nexus_relations_source_type ON nexus_relations (source_id, type)',
    );
    nativeDb.exec(
      'CREATE INDEX IF NOT EXISTS idx_nexus_relations_target_type ON nexus_relations (target_id, type)',
    );
    nativeDb.exec(
      'CREATE INDEX IF NOT EXISTS idx_nexus_relations_confidence ON nexus_relations (confidence)',
    );
  } finally {
    nativeDb.exec(`PRAGMA foreign_keys=${fkWasOn ? 'ON' : 'OFF'}`);
  }
}

/**
 * Apply the nexus-domain DELTA migration + idempotent safety nets on top of the
 * PREFIXED consolidated graph tables the PROJECT dual-scope chokepoint already
 * created (T11578 · AC3 · ADR-090 T11648).
 *
 * ## COMPLETE-CUTOVER (T11578 · AC3) + residency move (ADR-090 · T11648)
 *
 * The consolidated cleo-project migration OWNS the five PREFIXED graph tables
 * in the PROJECT `cleo.db` `main` (`nexus_nodes`, `nexus_relations`,
 * `nexus_contracts`, `nexus_code_index`, `nexus_relation_weights`); the
 * cross-project registry/identity tables are owned by the cleo-global migration
 * and reached through the {@link NEXUS_GLOBAL_ATTACH_ALIAS} attach. The runtime
 * no longer drops/rebuilds a legacy shape (former `establishLegacyNexusSchema`).
 * The `drizzle-nexus` set carries ONLY the delta the consolidated migration
 * cannot model:
 *   - the `nexus_relation_weights` sibling (plasticity partition, T11545),
 *   - the `nexus_symbols_fts` FTS5 virtual table + its three triggers (over the
 *     project-scope `nexus_nodes`), and
 *   - the `_nexus_meta` health-probe table (also the reconcile sentinel).
 *
 * The reconcile sentinel is `_nexus_meta` (a table the nexus migration ITSELF
 * creates, NOT a consolidated-owned table). This keeps `reconcileJournal`
 * Scenario 2 (orphan deletion) dormant until the nexus migration set is journaled
 * — otherwise the consolidated PROJECT migration's journal entries (written FIRST
 * by `openDualScopeDb`) would look like orphans and be deleted, corrupting the
 * shared journal (mirrors the conduit `_conduit_meta` sentinel, AC4).
 *
 * @task T5365
 * @task T11578
 * @task T11648
 */
function runNexusMigrations(
  nativeDb: DatabaseSync,
  db: NodeSQLiteDatabase<typeof nexusSchema>,
): void {
  const migrationsFolder = resolveNexusMigrationsFolder();

  // If existing DB with populated graph, create a safety backup (cleo compat).
  // Sentinel is `nexus_nodes` — the canonical project-scope graph table in
  // `main` (ADR-090 · T11648); the former `nexus_project_registry` sentinel now
  // lives in the attached GLOBAL db, not this project handle.
  if (tableExists(nativeDb, 'nexus_nodes') && _nexusDbPath) {
    const backupPath = _nexusDbPath.replace(/\.db$/, '-pre-cleo.db.bak');
    if (!existsSync(backupPath)) {
      try {
        copyFileSync(_nexusDbPath, backupPath);
      } catch {
        /* non-fatal */
      }
    }
  }

  // Reconcile the Drizzle journal first so existing DBs don't try to re-run the
  // comment-only baseline marker, and so removed legacy per-table migrations are
  // treated as true orphans (Sub-case B) rather than re-run. Sentinel =
  // `_nexus_meta` (created by the nexus delta migration itself — NOT a
  // consolidated-owned table; see the doc note above).
  reconcileJournal(nativeDb, migrationsFolder, '_nexus_meta', 'nexus');

  // Run the nexus DELTA migration (FTS5 quartet + nexus_relation_weights +
  // `_nexus_meta`). Wrapped in a busy retry — the GLOBAL `cleo.db` handle is
  // shared with sibling domains, so a concurrent open may briefly hold a lock.
  const MAX_RETRIES = 5;
  const BASE_DELAY_MS = 100;
  const MAX_DELAY_MS = 2000;
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      migrateWithRetry(db, migrationsFolder, nativeDb, '_nexus_meta', 'nexus');
      lastError = undefined;
      break;
    } catch (err) {
      if (!isSqliteBusy(err) || attempt === MAX_RETRIES) throw err;
      lastError = err;
      const delay = Math.min(
        BASE_DELAY_MS * 2 ** (attempt - 1) * (1 + Math.random() * 0.5),
        MAX_DELAY_MS,
      );
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.round(delay));
    }
  }
  /* c8 ignore next 1 */
  if (lastError) throw lastError;

  // Complete the plasticity partition: create the sibling table (the migration
  // also creates it idempotently), backfill, then DROP the inline plasticity
  // columns the consolidated T11363 `nexus_relations` still carries (T11578 · AC3).
  ensureNexusRelationWeights(nativeDb);

  // T1062 safety net: ensure `nexus_nodes.is_external` exists (the consolidated
  // T11363 shape already includes it; this is a belt-and-suspenders no-op).
  ensureColumns(
    nativeDb,
    'nexus_nodes',
    [{ name: 'is_external', ddl: 'integer DEFAULT 0' }],
    'nexus',
  );

  // T1839 safety net: (re)build the FTS5 virtual table + triggers and backfill
  // existing `nexus_nodes` rows. Idempotent — a no-op once the index exists.
  ensureNexusFts5(nativeDb);
}

/**
 * Initialize the consolidated PROJECT `cleo.db` (the nexus GRAPH home) with the
 * GLOBAL `cleo.db` ATTACHed for registry/identity reads, plus the nexus DELTA
 * schema within it (lazy, singleton).
 *
 * ## ADR-090 residency move — runtime read half (T11648)
 *
 * The four code-graph tables (`nexus_nodes`, `nexus_relations`, `nexus_contracts`,
 * `nexus_code_index`) + the `nexus_relation_weights` plasticity sibling now live
 * in PROJECT scope (`<projectRoot>/.cleo/cleo.db`) — that is where exodus WRITES
 * them. The runtime READ path therefore opens the PROJECT scope as `main` so the
 * graph is visible (previously it opened GLOBAL and read empty graph tables —
 * the T11538/T11539 gap). The cross-project registry/identity tables stay GLOBAL;
 * we open GLOBAL first (so its consolidated migration creates them) then ATTACH
 * it under {@link NEXUS_GLOBAL_ATTACH_ALIAS} so the registry/identity accessors —
 * which reference bare names (`nexus_project_registry`, `nexus_user_profile`,
 * `nexus_sigils`, `nexus_project_id_aliases`, `nexus_audit_log`,
 * `nexus_schema_meta`) — resolve via SQLite's bare-name fall-through to the
 * attached GLOBAL db. ADR-036's global-only assertion is relaxed for the four
 * graph tables ONLY (registry stays global-asserted in {@link getNexusRegistryDbPath}).
 *
 * Uses a promise guard so concurrent callers wait for the same initialization to
 * complete (migrations are async).
 *
 * @task T307
 * @task T11524 (E6-L4 — dual-scope chokepoint delegation)
 * @task T11578 (AC3 — prefixed `nexus_*` tables)
 * @task T11648 (ADR-090 runtime read half — project-scope graph + global attach)
 */
export async function getNexusDb(): Promise<NodeSQLiteDatabase<typeof nexusSchema>> {
  const requestedPath = getNexusDbPath();

  // If singleton exists but points to a different path (e.g. CLEO_HOME changed
  // between tests), reset it.
  if (_nexusDb && _nexusDbPath !== requestedPath) {
    resetNexusDbState();
  }

  // Liveness guard (T11524): nexus shares the consolidated PROJECT `cleo.db`
  // handle with the other project-tier domains (tasks/brain/conduit). Another
  // domain may have closed + re-opened the shared `DatabaseSync` while our nexus
  // singleton still references the now-closed handle. Detect a stale (closed)
  // handle and drop the singleton so we re-derive from the live openDualScopeDb
  // cache below.
  if (_nexusDb && (_nexusNativeDb === null || !_nexusNativeDb.isOpen)) {
    resetNexusDbState();
  }

  if (_nexusDb) {
    // Re-validate the GLOBAL registry ATTACH on every singleton hit (ADR-090 ·
    // T11648). The registry home (`getCleoHome()`) can change between calls —
    // tests that mutate `CLEO_HOME` while the cwd-keyed project handle stays
    // cached, or a sibling domain that re-opened the shared project handle and
    // dropped the attach. `ensureGlobalRegistryAttached` early-returns when the
    // current attach already points at the right file, so this is cheap.
    if (_nexusNativeDb) {
      try {
        ensureGlobalRegistryAttached(_nexusNativeDb);
      } catch {
        // A failed re-attach means the shared handle is unusable — drop the
        // singleton so the next call re-derives a fresh handle + attach.
        resetNexusDbState();
      }
    }
    if (_nexusDb) return _nexusDb;
  }

  // If already initializing, wait for the in-flight init
  if (_nexusInitPromise) return _nexusInitPromise;

  _nexusInitPromise = (async () => {
    const dbPath = requestedPath;
    _nexusDbPath = dbPath;

    // ADR-086 / T10321 — warn (one-shot, non-blocking) if the install still
    // carries the nested-nexus migration debris. Does not alter the open.
    detectAndWarnOnNestedNexus();

    // ── Registry home: open GLOBAL first (T11648) ──────────────────────────
    // The registry/identity tables are global (ADR-090 §2.2). Opening the GLOBAL
    // scope through the dual-scope chokepoint runs its consolidated migration,
    // guaranteeing those tables (and their schema) physically exist before we
    // ATTACH the global file into the project handle below. This is the same
    // shared handle the global-tier siblings (skills/agent-registry) hold; we do
    // NOT keep a reference to it — we only need its schema materialised on disk.
    await openDualScopeDb('global');

    // ── Graph home: open PROJECT scope as `main` (T11648 · ADR-090 §2.1/§2.4) ─
    // openDualScopeDb('project', cwd) applies the pragma SSoT, creates the
    // directory, runs the consolidated cleo-project migrations (which OWN the
    // five PREFIXED graph tables), and manages the singleton cache. We extract
    // its native handle and re-wrap it with the `nexusSchema` drizzle instance.
    const dualHandle = await openDualScopeDb('project', process.cwd());

    // Extract the underlying DatabaseSync. Drizzle exposes it via `$client`.
    const nativeDb = (dualHandle.db as { $client?: DatabaseSync }).$client ?? null;
    if (!nativeDb) {
      throw new Error(
        'T11648: openDualScopeDb returned a handle without $client — ' +
          'cannot extract DatabaseSync for the nexus-schema drizzle wrapping.',
      );
    }
    _nexusNativeDb = nativeDb;

    // ATTACH the GLOBAL `cleo.db` so the registry/identity tables resolve by
    // their bare names via SQLite's fall-through (ADR-090 · T11648). Idempotent.
    ensureGlobalRegistryAttached(nativeDb);

    // Wrap the native handle with the `nexusSchema` drizzle instance so existing
    // accessors (nexusSchema.* queries) run unchanged: graph tables resolve to
    // the project `main`; registry/identity tables fall through to the attach.
    const db = drizzle({ client: nativeDb, schema: nexusSchema });

    // Apply the nexus DELTA migration + idempotent safety nets on top of the
    // consolidated prefixed tables openDualScopeDb already created: the FTS5
    // quartet, the `nexus_relation_weights` plasticity partition (incl. the
    // inline-column DROP), and the `_nexus_meta` health-probe sentinel. The
    // legacy drop/rebuild (`establishLegacyNexusSchema`) is GONE — the
    // consolidated migration is the single SSoT for the base tables (T11578 · AC3).
    runNexusMigrations(nativeDb, db);

    // Seed schema version for new databases (no-op if already set)
    nativeDb
      .prepare(
        `INSERT OR IGNORE INTO nexus_schema_meta (key, value) VALUES ('schemaVersion', '${NEXUS_SCHEMA_VERSION}')`,
      )
      .run();

    // Set singleton only after migrations complete
    _nexusDb = db;
    return db;
  })();

  try {
    return await _nexusInitPromise;
  } finally {
    _nexusInitPromise = null;
  }
}

/**
 * Close the nexus-domain database connection and release resources.
 *
 * ## E6-L4 (T11524) · ADR-090 runtime read half (T11648)
 *
 * The nexus GRAPH domain now SHARES the consolidated PROJECT `cleo.db` handle
 * with the other project-tier domains (tasks/brain/conduit — all open it via
 * {@link openDualScopeDb}('project'), same cache key), with the GLOBAL `cleo.db`
 * ATTACHed for registry/identity reads. This function therefore must NOT close
 * the underlying `DatabaseSync` nor evict the dual-scope cache — doing so would
 * break in-flight queries from those siblings with "database is not open". It
 * only drops the nexus-domain singleton references; the shared handle's lifecycle
 * (and the global ATTACH) is owned by `openDualScopeDb` and torn down by a
 * coordinated reset (`closeAllDatabases` → `_resetDualScopeDbCache`).
 */
export function closeNexusDb(): void {
  // Drop only the nexus singleton references. Do NOT close `_nexusNativeDb` — it
  // is the shared dual-scope project handle, possibly still in use by siblings.
  _nexusNativeDb = null;
  _nexusDb = null;
  _nexusDbPath = null;
  _nexusInitPromise = null;
}

/**
 * Reset nexus singleton state without saving.
 * Used during tests or when the database file is recreated.
 * Safe to call multiple times.
 *
 * ## E6-L4 (T11524) · ADR-090 runtime read half (T11648)
 *
 * Drops only the nexus-domain singleton references — does NOT close the shared
 * dual-scope PROJECT `cleo.db` handle nor evict the dual-scope cache (that handle
 * is shared with the other project-tier domains). Mirrors {@link closeNexusDb}.
 */
export function resetNexusDbState(): void {
  _nexusNativeDb = null;
  _nexusDb = null;
  _nexusDbPath = null;
  _nexusInitPromise = null;
}

/**
 * Get the underlying node:sqlite DatabaseSync instance for the nexus domain.
 * Useful for direct PRAGMA calls or raw SQL operations.
 * Returns null if the database hasn't been initialized.
 */
export function getNexusNativeDb(): DatabaseSync | null {
  return _nexusNativeDb;
}

export type { NodeSQLiteDatabase };
/**
 * Re-export nexus schema for external use.
 */
export { nexusSchema };
