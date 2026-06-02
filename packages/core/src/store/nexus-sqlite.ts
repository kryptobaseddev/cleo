/**
 * SQLite store for the global-scope NEXUS domain via drizzle-orm/node-sqlite +
 * node:sqlite (DatabaseSync).
 *
 * ## E6-L4 — thin-facade migration (T11524)
 *
 * `getNexusDb()` is now a thin facade that delegates the database open to
 * {@link openDualScopeDb}('global') — the canonical dual-scope chokepoint
 * introduced by E3/E4 (T11512/T11517) and already adopted by the tasks domain
 * (E6-L1, T11521), the brain domain (E6-L2, T11522), and the conduit domain
 * (E6-L3, T11523). This is the GLOBAL-scope variant: nexus is a cross-project
 * registry and stays GLOBAL — its tables live inside the consolidated GLOBAL
 * `cleo.db` under {@link getCleoHome}, NOT a per-project `.cleo/` file.
 *
 * This ensures:
 *
 * - Every nexus-domain open flows through the single pragma SSoT (ADR-068/069).
 * - The nexus tables now live inside the consolidated GLOBAL `cleo.db` — NOT a
 *   separate `nexus.db` file — co-existing with `signaldock_*` / `skills_*` /
 *   global `brain_*`.
 * - DB Open Guard Gate 3 (`scripts/lint-no-direct-db-open.mjs`) stays green: the
 *   only native open is inside `dual-scope-db.ts`. The remaining raw opens in
 *   `nexus/**` migration scripts are the allowlisted migration paths.
 *
 * ## COMPLETE-CUTOVER to prefixed `nexus_*` tables (T11578 · AC3)
 *
 * The nexus runtime READ + WRITE path now targets the PREFIXED consolidated
 * `nexus_*` tables that the consolidated cleo-global migration
 * (`drizzle-cleo-global/…t11363-consolidation-cleo-global`) creates and OWNS —
 * the single SSoT for the 10 base tables (`nexus_project_registry`,
 * `nexus_project_id_aliases`, `nexus_user_profile`, `nexus_sigils`, `nexus_nodes`,
 * `nexus_relations`, `nexus_contracts`, `nexus_code_index`, `nexus_audit_log`,
 * `nexus_schema_meta`). The former legacy drop/rebuild (`establishLegacyNexusSchema`)
 * and the BARE registry tables (`project_registry`, `user_profile`, `sigils`,
 * `project_id_aliases`) are GONE. The runtime schema barrel `schema/nexus-schema.ts`
 * now maps those four export symbols (`projectRegistry`, `userProfile`, `sigils`,
 * `projectIdAliases`) to the prefixed physical tables — accessors need ZERO change.
 *
 * The `drizzle-nexus` migration set carries ONLY the delta the consolidated
 * migration cannot model: the `nexus_symbols_fts` FTS5 virtual table + its three
 * `nexus_nodes` triggers, the `nexus_relation_weights` plasticity-partition
 * sibling (T11545), and the `_nexus_meta` health-probe table (the reconcile
 * sentinel). The destructive half of the plasticity partition (DROP the inline
 * `weight`/`last_accessed_at`/`co_accessed_count` columns the T11363
 * `nexus_relations` still carries) is applied idempotently at open by
 * `ensureNexusRelationWeights` — never as a non-idempotent journaled ALTER.
 *
 * The four nexus code-graph tables keep their `project_id` column (the runtime
 * keeps a SINGLE global handle; the graph accessors filter by `project_id`). The
 * ADR-090 residency MOVE to PROJECT scope (drop `project_id`, open per-project
 * handles) is a SEPARATE later task (T11538/T11539) — out of scope for AC3.
 *
 * @adr ADR-036 — nexus.db (now the global `cleo.db`) is global-only.
 * @task T5365
 * @task T11524 - E6-L4: route getNexusDb through openDualScopeDb('global') (SG-DB-SUBSTRATE-V2)
 * @task T11578 - AC3: COMPLETE-CUTOVER nexus runtime → prefixed nexus_* consolidated tables
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
 * Returns the global-tier nexus DB path — the consolidated GLOBAL `cleo.db`.
 *
 * E6-L4 (T11524): delegates to {@link resolveDualScopeDbPath}('global'), which
 * resolves `getCleoHome()` + `cleo.db`. nexus is a cross-project registry and
 * must live in the global CLEO home directory (`~/.local/share/cleo/` on Linux
 * via XDG). It is NEVER written to a per-project `.cleo/` directory.
 *
 * @task T307
 * @epic T299
 * @why ADR-036 §Decision/Global-Tier: nexus is global-only. This guard
 *   throws immediately if path resolution ever drifts outside getCleoHome(),
 *   preventing silent creation of project-tier stray DB files. The dual-scope
 *   global resolver builds the path from getCleoHome() so the invariant holds;
 *   the assertion is retained as defence-in-depth against future regressions.
 * @throws {Error} If the resolved path is not under `getCleoHome()` — this
 *   indicates a code path that bypasses canonical path resolution and is a
 *   bug that must be fixed rather than silently tolerated.
 */
export function getNexusDbPath(): string {
  const cleoHome = getCleoHome();
  const nexusPath = resolveDualScopeDbPath('global');

  // Guard: the resolved path MUST be under the global tier (ADR-036). The
  // dual-scope global resolver joins getCleoHome() with 'cleo.db', so the
  // invariant is always satisfied under normal operation. The assertion catches
  // hypothetical future regressions where getCleoHome() is monkey-patched or the
  // resolver drifts.
  if (!nexusPath.startsWith(cleoHome)) {
    throw new Error(
      `BUG: getNexusDbPath() resolved to "${nexusPath}" which is NOT under ` +
        `getCleoHome() ("${cleoHome}"). nexus is global-only per ADR-036. ` +
        `This indicates a code path that bypasses canonical path resolution — ` +
        `fix the caller, do not suppress this error.`,
    );
  }

  return nexusPath;
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
 * PREFIXED consolidated `nexus_*` tables the dual-scope chokepoint already
 * created (T11578 · AC3).
 *
 * ## COMPLETE-CUTOVER (T11578 · AC3)
 *
 * The consolidated cleo-global migration (T11363) OWNS the 10 prefixed nexus base
 * tables (`nexus_project_registry`, `nexus_user_profile`, `nexus_sigils`,
 * `nexus_project_id_aliases`, `nexus_nodes`, `nexus_relations`, `nexus_contracts`,
 * `nexus_code_index`, `nexus_audit_log`, `nexus_schema_meta`). The runtime no
 * longer drops/rebuilds a legacy shape (former `establishLegacyNexusSchema`) and
 * no longer creates the BARE registry tables. The `drizzle-nexus` set carries
 * ONLY the delta the consolidated migration cannot model:
 *   - the `nexus_relation_weights` sibling (plasticity partition, T11545),
 *   - the `nexus_symbols_fts` FTS5 virtual table + its three triggers, and
 *   - the `_nexus_meta` health-probe table (also the reconcile sentinel).
 *
 * The reconcile sentinel is `_nexus_meta` (a table the nexus migration ITSELF
 * creates, NOT a consolidated-owned table). This keeps `reconcileJournal`
 * Scenario 2 (orphan deletion) dormant until the nexus migration set is journaled
 * — otherwise the consolidated migration's journal entries (written FIRST by
 * `openDualScopeDb`) would look like orphans and be deleted, corrupting the shared
 * journal (mirrors the conduit `_conduit_meta` sentinel, AC4).
 *
 * @task T5365
 * @task T11578
 */
function runNexusMigrations(
  nativeDb: DatabaseSync,
  db: NodeSQLiteDatabase<typeof nexusSchema>,
): void {
  const migrationsFolder = resolveNexusMigrationsFolder();

  // If existing DB with pending migrations, create safety backup (cleo compat).
  // Sentinel is the prefixed consolidated registry table (T11578 · AC3).
  if (tableExists(nativeDb, 'nexus_project_registry') && _nexusDbPath) {
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
 * Initialize the consolidated GLOBAL `cleo.db` and the nexus DELTA schema within
 * it (lazy, singleton).
 *
 * T11578 · AC3: delegates the physical open to {@link openDualScopeDb}('global')
 * — the canonical dual-scope chokepoint, which runs the consolidated cleo-global
 * migrations that OWN the prefixed `nexus_*` base tables — and re-wraps its native
 * handle with the `nexusSchema` drizzle instance (now mapping the PREFIXED
 * physical tables). Returns the drizzle ORM instance (async via the dual-scope
 * migration step).
 *
 * Uses a promise guard so concurrent callers wait for the same
 * initialization to complete (migrations are async).
 */
export async function getNexusDb(): Promise<NodeSQLiteDatabase<typeof nexusSchema>> {
  const requestedPath = getNexusDbPath();

  // If singleton exists but points to a different path (e.g. CLEO_HOME changed
  // between tests), reset it.
  if (_nexusDb && _nexusDbPath !== requestedPath) {
    resetNexusDbState();
  }

  // Liveness guard (T11524): nexus shares the consolidated GLOBAL `cleo.db`
  // handle with the other global-tier domains (signaldock/skills, E6-L5). Another
  // domain may have closed + re-opened the shared `DatabaseSync` while our nexus
  // singleton still references the now-closed handle. Detect a stale (closed)
  // handle and drop the singleton so we re-derive from the live openDualScopeDb
  // cache below.
  if (_nexusDb && (_nexusNativeDb === null || !_nexusNativeDb.isOpen)) {
    resetNexusDbState();
  }

  if (_nexusDb) return _nexusDb;

  // If already initializing, wait for the in-flight init
  if (_nexusInitPromise) return _nexusInitPromise;

  _nexusInitPromise = (async () => {
    const dbPath = requestedPath;
    _nexusDbPath = dbPath;

    // ADR-086 / T10321 — warn (one-shot, non-blocking) if the install still
    // carries the nested-nexus migration debris. Does not alter the open.
    detectAndWarnOnNestedNexus();

    // ── Dual-scope chokepoint delegation (T11524 · E6-L4 · T11578 · AC3) ───
    // openDualScopeDb('global') applies the pragma SSoT, creates the directory,
    // runs the consolidated cleo-global migrations (which OWN the PREFIXED
    // `nexus_*` base tables), and manages the singleton cache. We extract its
    // native handle and re-wrap it with the `nexusSchema` drizzle instance (now
    // mapping the prefixed physical tables) so existing accessors run unchanged.
    const dualHandle = await openDualScopeDb('global');

    // Extract the underlying DatabaseSync. Drizzle exposes it via `$client`.
    const nativeDb = (dualHandle.db as { $client?: DatabaseSync }).$client ?? null;
    if (!nativeDb) {
      throw new Error(
        'T11578 · AC3: openDualScopeDb returned a handle without $client — ' +
          'cannot extract DatabaseSync for the nexus-schema drizzle wrapping.',
      );
    }
    _nexusNativeDb = nativeDb;

    // Wrap the native handle with the `nexusSchema` drizzle instance so existing
    // accessors (nexusSchema.* queries) run against the PREFIXED tables unchanged.
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
 * ## E6-L4 (T11524)
 *
 * The nexus domain now SHARES the consolidated GLOBAL `cleo.db` handle with the
 * other global-tier domains (signaldock/skills, E6-L5 — all open it via
 * {@link openDualScopeDb}('global'), same cache key). This function therefore must
 * NOT close the underlying `DatabaseSync` nor evict the dual-scope cache — doing
 * so would break in-flight queries from those siblings with "database is not
 * open". It only drops the nexus-domain singleton references; the shared handle's
 * lifecycle is owned by `openDualScopeDb` and torn down by a coordinated reset
 * (`closeAllDatabases` → `_resetDualScopeDbCache`).
 */
export function closeNexusDb(): void {
  // Drop only the nexus singleton references. Do NOT close `_nexusNativeDb` — it
  // is the shared dual-scope handle, possibly still in use by global siblings.
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
 * ## E6-L4 (T11524)
 *
 * Drops only the nexus-domain singleton references — does NOT close the shared
 * dual-scope GLOBAL `cleo.db` handle nor evict the dual-scope cache (that handle
 * is shared with the other global-tier domains). Mirrors {@link closeNexusDb}.
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
