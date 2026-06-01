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
 * The legacy `drizzle-nexus` migrations are still applied to this handle during
 * the E3→E6 transition. They create the legacy runtime-queried physical tables
 * (`nexus_nodes`, `nexus_relations`, `nexus_contracts`, `project_registry`,
 * `project_id_aliases`, `nexus_audit_log`, `nexus_schema_meta`, `user_profile`,
 * `sigils`) plus the FTS5 virtual table + triggers (`nexus_symbols_fts`) that
 * Drizzle cannot model. The consolidated GLOBAL schema (`drizzle-cleo-global`)
 * creates a domain-prefixed subset (`nexus_nodes` / `nexus_relations` /
 * `nexus_contracts` / `nexus_audit_log` / `nexus_schema_meta` collide by name
 * but carry the exodus-TARGET shape — ISO-8601 timestamps + enum/format CHECK
 * constraints) which the runtime nexus writers cannot use. On first open we drop
 * those consolidated-target collisions and run the legacy `drizzle-nexus`
 * migrations to recreate them in the runtime shape — exactly mirroring the brain
 * domain (E6-L2). The residency MOVE of the nexus graph tables global→project is
 * a SEPARATE later task (T11538, post-E6) — this task keeps the ADR-036
 * global-only invariant intact.
 *
 * @adr ADR-036 — nexus.db (now the global `cleo.db`) is global-only.
 * @task T5365
 * @task T11524 - E6-L4: route getNexusDb through openDualScopeDb('global') (SG-DB-SUBSTRATE-V2)
 */

import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
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
 * The consolidated (exodus-target) nexus tables that COLLIDE with the legacy
 * `drizzle-nexus` schema by physical name. The {@link openDualScopeDb}('global')
 * consolidation migration (`drizzle-cleo-global`, T11363) creates these in the
 * exodus-target shape (ISO-8601 `text` timestamps + enum/format `CHECK`
 * constraints — e.g. `nexus_nodes.kind IN (…)`, `nexus_relations.indexed_at
 * GLOB '[0-9]…'`). The runtime nexus writers and `nexusSchema`
 * (`nexus-schema.ts`) use the legacy shape — no CHECKs — so on first open we
 * drop these and let the legacy `CREATE TABLE IF NOT EXISTS` migrations recreate
 * them.
 *
 * The non-colliding consolidated tables (`nexus_project_registry`,
 * `nexus_project_id_aliases`, `nexus_user_profile`, `nexus_sigils`,
 * `nexus_code_index`) carry DIFFERENT physical names than the legacy bare names
 * (`project_registry`, `project_id_aliases`, `user_profile`, `sigils`) so they
 * co-exist harmlessly — like the tasks domain (`tasks` ≠ `tasks_tasks`). The
 * exodus (T11248 / T11553) and the nexus residency move (T11538) reconcile them.
 *
 * @internal
 * @task T11524
 */
const CONSOLIDATED_NEXUS_TABLES = [
  'nexus_nodes',
  'nexus_relations',
  'nexus_contracts',
  'nexus_audit_log',
  'nexus_schema_meta',
] as const;

/**
 * Detect whether the colliding nexus tables in the open handle carry the
 * CONSOLIDATED (exodus-target) shape rather than the LEGACY runtime shape.
 *
 * The consolidation migration (T11363) adds enum/format `CHECK` constraints to
 * `nexus_nodes` (`kind IN (…)`, `indexed_at GLOB '[0-9]…'`); the legacy runtime
 * schema (`nexus-schema.ts`) has none. The colliding tables share the SAME
 * physical name AND the same column affinities (both `indexed_at text`), so the
 * column type is not a discriminator — instead we inspect the stored DDL in
 * `sqlite_master` for the consolidation CHECK marker.
 *
 * @internal
 * @task T11524
 */
function nexusTablesAreConsolidatedShape(nativeDb: DatabaseSync): boolean {
  if (!tableExists(nativeDb, 'nexus_nodes')) return false;
  const row = nativeDb
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='nexus_nodes'")
    .get() as { sql?: string } | undefined;
  const sql = row?.sql ?? '';
  // Legacy `nexus_nodes` has NO CHECK constraint; the consolidated target carries
  // `CHECK ("kind" IN (…))`. Presence of a CHECK clause means the handle holds the
  // consolidated (exodus-target) shape and must be rebuilt to the legacy shape.
  return /\bCHECK\b/i.test(sql);
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
 * Idempotent safety net for `nexus_relation_weights` (T11545 · ADR-090 §5.3).
 *
 * The Hebbian plasticity columns were partitioned out of `nexus_relations` into
 * this sibling 1:1 table. This safety net mirrors the prior T998 `ensureColumns`
 * band-aid: it CREATEs the table (+ indexes) on existing nexus instances that
 * predate the T11545 drizzle migration, and — when the legacy inline columns are
 * still present on `nexus_relations` (pre-partition DBs whose migration chain has
 * not yet reached T11545) — backfills any non-default plasticity state so the
 * accessor never loses weights. Every statement is guarded; safe to re-run.
 *
 * @task T11545
 */
function ensureNexusRelationWeights(nativeDb: DatabaseSync): void {
  // Only meaningful once the parent graph table exists.
  if (!tableExists(nativeDb, 'nexus_relations')) return;

  const alreadyExists = tableExists(nativeDb, 'nexus_relation_weights');

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

  // Backfill from the legacy inline columns IFF they are still present and this
  // is the first time the sibling table is created (avoids clobbering rows the
  // running accessor may have written since the partition migration).
  if (alreadyExists) return;
  const relCols = nativeDb.prepare('PRAGMA table_info(nexus_relations)').all() as Array<{
    name: string;
  }>;
  const hasInlinePlasticity = relCols.some((c) => c.name === 'weight');
  if (!hasInlinePlasticity) return;

  nativeDb.exec(`
    INSERT OR IGNORE INTO nexus_relation_weights (relation_id, weight, last_accessed_at, co_accessed_count)
    SELECT id, COALESCE(weight, 0.0), last_accessed_at, COALESCE(co_accessed_count, 0)
      FROM nexus_relations
     WHERE COALESCE(weight, 0.0) > 0.0
        OR last_accessed_at IS NOT NULL
        OR COALESCE(co_accessed_count, 0) > 0
  `);
}

/**
 * Run drizzle migrations to create/update the legacy nexus tables inside the
 * consolidated GLOBAL `cleo.db`.
 *
 * Uses IMMEDIATE transactions to prevent concurrent migration races.
 * Follows the same pattern as memory-sqlite.ts runBrainMigrations().
 *
 * @task T5365
 */
function runNexusMigrations(
  nativeDb: DatabaseSync,
  db: NodeSQLiteDatabase<typeof nexusSchema>,
): void {
  const migrationsFolder = resolveNexusMigrationsFolder();

  // If existing DB with pending migrations, create safety backup (cleo compat)
  if (tableExists(nativeDb, 'project_registry') && _nexusDbPath) {
    const backupPath = _nexusDbPath.replace(/\.db$/, '-pre-cleo.db.bak');
    if (!existsSync(backupPath)) {
      try {
        copyFileSync(_nexusDbPath, backupPath);
      } catch {
        /* non-fatal */
      }
    }
  }

  // Bootstrap existing databases that predate drizzle migrations.
  // Mark baseline migration as already applied if tables exist but
  // __drizzle_migrations doesn't.
  if (tableExists(nativeDb, 'project_registry') && !tableExists(nativeDb, '__drizzle_migrations')) {
    const migrations = readMigrationFiles({ migrationsFolder });
    const baseline = migrations[0];
    if (baseline) {
      nativeDb
        .prepare(
          `CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (id INTEGER PRIMARY KEY AUTOINCREMENT, hash text NOT NULL, created_at numeric)`,
        )
        .run();
      nativeDb
        .prepare(
          `INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES ('${baseline.hash}', ${baseline.folderMillis})`,
        )
        .run();
    }
  }

  // T11545: idempotent safety net for the partitioned plasticity table —
  // covers pre-migration nexus instances created before the T11545 migration
  // runs (it CREATEs the sibling table + backfills any legacy inline columns).
  // No-op when the table already exists.
  ensureNexusRelationWeights(nativeDb);

  // T1062: idempotent safety net for external module nodes — covers pre-migration
  // nexus instances that were created before the drizzle migration runs.
  // Unresolved imports are persisted as ExternalModule nodes with is_external=true.
  ensureColumns(
    nativeDb,
    'nexus_nodes',
    [{ name: 'is_external', ddl: 'integer DEFAULT 0' }],
    'nexus',
  );

  // T1065: idempotent safety net for contracts table — covers pre-migration
  // nexus instances that were created before contracts extraction.
  // If the table doesn't exist after migrations, it will be created here.
  if (!tableExists(nativeDb, 'nexus_contracts')) {
    nativeDb
      .prepare(
        `CREATE TABLE IF NOT EXISTS nexus_contracts (
        contract_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('http', 'grpc', 'topic')),
        path TEXT NOT NULL,
        method TEXT,
        request_schema_json TEXT NOT NULL DEFAULT '{}',
        response_schema_json TEXT NOT NULL DEFAULT '{}',
        source_symbol_id TEXT,
        route_node_id TEXT,
        confidence REAL NOT NULL DEFAULT 1.0,
        description TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      )
      .run();

    // Create indexes
    nativeDb
      .prepare(
        'CREATE INDEX IF NOT EXISTS idx_nexus_contracts_project ON nexus_contracts(project_id)',
      )
      .run();
    nativeDb
      .prepare('CREATE INDEX IF NOT EXISTS idx_nexus_contracts_type ON nexus_contracts(type)')
      .run();
    nativeDb
      .prepare('CREATE INDEX IF NOT EXISTS idx_nexus_contracts_path ON nexus_contracts(path)')
      .run();
    nativeDb
      .prepare('CREATE INDEX IF NOT EXISTS idx_nexus_contracts_method ON nexus_contracts(method)')
      .run();
    nativeDb
      .prepare(
        'CREATE INDEX IF NOT EXISTS idx_nexus_contracts_project_type ON nexus_contracts(project_id, type)',
      )
      .run();
    nativeDb
      .prepare(
        'CREATE INDEX IF NOT EXISTS idx_nexus_contracts_source_symbol ON nexus_contracts(source_symbol_id)',
      )
      .run();
    nativeDb
      .prepare(
        'CREATE INDEX IF NOT EXISTS idx_nexus_contracts_created ON nexus_contracts(created_at)',
      )
      .run();
  }

  // T1839: idempotent safety net for FTS5 virtual table + triggers.
  // Covers existing nexus instances that were created before this migration.
  // Each statement uses nativeDb.exec() (not prepare().run()) so that the entire
  // DDL block executes atomically without the node:sqlite first-statement-only limit.
  ensureNexusFts5(nativeDb);

  // T9183: Reconcile partial migrations before running migrate (matches brain.db
  // pattern in memory-sqlite.ts). When a legacy nexus DB has columns from prior
  // ensureColumns() repair but no journal entries, reconcileJournal Scenario 3
  // marks those migrations applied via DDL probe so migrateWithRetry doesn't
  // hit duplicate-column errors on the legacy-upgrade path.
  reconcileJournal(nativeDb, migrationsFolder, 'project_registry', 'nexus');

  // Run pending migrations via migrateWithRetry which catches duplicate-column
  // errors and triggers Scenario 3 reconciliation as a belt-and-suspenders
  // safety net (T9183, matches memory-sqlite.ts:99 brain pattern).
  const MAX_RETRIES = 5;
  const BASE_DELAY_MS = 100;
  const MAX_DELAY_MS = 2000;
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      migrateWithRetry(db, migrationsFolder, nativeDb, 'project_registry', 'nexus');
      // T1062: post-migration safety net for is_external — ensures the column exists
      // on fresh DBs where ensureColumns ran before the table was created, and on
      // old DBs where this column was added after initial schema creation.
      ensureColumns(
        nativeDb,
        'nexus_nodes',
        [{ name: 'is_external', ddl: 'integer DEFAULT 0' }],
        'nexus',
      );
      return;
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
  /* c8 ignore next */
  throw lastError;
}

/**
 * Establish the LEGACY nexus-domain schema inside the consolidated GLOBAL
 * `cleo.db`, replacing the consolidated (exodus-target) nexus tables that
 * collide by name.
 *
 * ## Why (T11524 · E6-L4)
 *
 * Routing `getNexusDb()` through {@link openDualScopeDb}('global') runs the
 * T11363 consolidation migration, which creates the colliding `nexus_*` tables
 * (see {@link CONSOLIDATED_NEXUS_TABLES}) in their **exodus-target** shape:
 * ISO-8601 `text` timestamps and enum/format `CHECK` constraints (e.g.
 * `nexus_nodes.kind IN (…)`, `nexus_relations.indexed_at GLOB '[0-9]…'`). The
 * runtime nexus writers and `nexusSchema` (`nexus-schema.ts`) use the **legacy**
 * shape — no enum/format CHECKs — exactly as the brain domain keeps using the
 * legacy shape after E6-L2.
 *
 * The legacy and consolidated tables share the SAME physical names, so they
 * cannot co-exist. The runtime must win, so on first open we drop the
 * consolidated colliding tables and run the legacy `drizzle-nexus` migrations
 * (all `CREATE TABLE IF NOT EXISTS`) to recreate them in the runtime shape. The
 * consolidated-target cutover and the nexus residency move (global→project) are
 * separate exodus jobs — see T11248 / T11553 / T11538.
 *
 * Idempotent: after the first rebuild the colliding tables are already
 * legacy-shaped, so {@link nexusTablesAreConsolidatedShape} returns `false` and
 * this only reconciles/applies the `drizzle-nexus` journal (nothing is dropped).
 *
 * @internal
 * @task T11524
 */
function establishLegacyNexusSchema(
  nativeDb: DatabaseSync,
  db: NodeSQLiteDatabase<typeof nexusSchema>,
): void {
  const log = getLogger('nexus-schema');

  if (nexusTablesAreConsolidatedShape(nativeDb)) {
    // Drop the consolidated (exodus-target) colliding nexus tables so the legacy
    // `drizzle-nexus` migrations can recreate them in the runtime shape. The
    // FTS5 virtual table + triggers (`nexus_symbols_fts`) reference `nexus_nodes`;
    // dropping `nexus_nodes` orphans them, so drop the FTS5 artifacts too and let
    // `ensureNexusFts5` (called by `runNexusMigrations`) rebuild them cleanly.
    // Disable FKs during the drop so cross-table references do not block the
    // teardown — then RESTORE the prior pragma state (the dual-scope pragma SSoT
    // enables foreign_keys; leaving it OFF would break the idempotent-pragma
    // contract, T10314).
    const fkRow = nativeDb.prepare('PRAGMA foreign_keys').get() as
      | { foreign_keys?: number }
      | undefined;
    const fkWasOn = fkRow?.foreign_keys === 1;
    nativeDb.exec('PRAGMA foreign_keys=OFF');
    try {
      // FTS5 triggers + virtual table first (they reference nexus_nodes).
      nativeDb.exec('DROP TRIGGER IF EXISTS nexus_nodes_fts_ai');
      nativeDb.exec('DROP TRIGGER IF EXISTS nexus_nodes_fts_ad');
      nativeDb.exec('DROP TRIGGER IF EXISTS nexus_nodes_fts_au');
      nativeDb.exec('DROP TABLE IF EXISTS nexus_symbols_fts');
      for (const table of CONSOLIDATED_NEXUS_TABLES) {
        try {
          nativeDb.exec(`DROP TABLE IF EXISTS \`${table}\``);
        } catch (err) {
          log.warn(
            { table, err },
            'Failed to drop consolidated nexus table during legacy rebuild.',
          );
        }
      }
    } finally {
      // Restore the pragma to its pre-drop state (ON under the dual-scope SSoT).
      nativeDb.exec(`PRAGMA foreign_keys=${fkWasOn ? 'ON' : 'OFF'}`);
    }
    log.debug(
      { count: CONSOLIDATED_NEXUS_TABLES.length },
      'Dropped consolidated (exodus-target) nexus tables — rebuilding in legacy runtime shape.',
    );
  }

  // Run the legacy `drizzle-nexus` migrations to (re)create the runtime-shaped
  // nexus tables + FTS5 artifacts. Their `__drizzle_migrations` journal is shared
  // with the cleo-global journal in the same `cleo.db`; the hashes are disjoint so
  // the nexus migrations are reconciled/applied independently.
  runNexusMigrations(nativeDb, db);
}

/**
 * Initialize the consolidated GLOBAL `cleo.db` and the legacy nexus tables
 * within it (lazy, singleton).
 *
 * E6-L4 (T11524): delegates the physical open to {@link openDualScopeDb}('global')
 * — the canonical dual-scope chokepoint — and re-wraps its native handle with the
 * legacy `nexusSchema` drizzle instance so existing callers compile unchanged.
 * Returns the drizzle ORM instance (async via the dual-scope migration step).
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

    // ── Dual-scope chokepoint delegation (T11524 · E6-L4) ─────────────────
    // openDualScopeDb('global') applies the pragma SSoT, creates the directory,
    // runs the consolidated cleo-global migrations (which create the colliding
    // `nexus_*` tables in exodus-target shape), and manages the singleton cache.
    // We extract its native handle so we can re-wrap it with the legacy
    // nexus-schema and rebuild the runtime-shaped nexus tables.
    const dualHandle = await openDualScopeDb('global');

    // Extract the underlying DatabaseSync. Drizzle exposes it via `$client`.
    const nativeDb = (dualHandle.db as { $client?: DatabaseSync }).$client ?? null;
    if (!nativeDb) {
      throw new Error(
        'E6-L4: openDualScopeDb returned a handle without $client — ' +
          'cannot extract DatabaseSync for legacy nexus-schema wrapping.',
      );
    }
    _nexusNativeDb = nativeDb;

    // Wrap the native handle with the legacy nexus-schema drizzle instance so
    // existing callers (nexusSchema.* queries) continue to work unchanged.
    const db = drizzle({ client: nativeDb, schema: nexusSchema });

    // Establish the LEGACY nexus-domain schema inside the consolidated GLOBAL
    // cleo.db. openDualScopeDb created the colliding nexus tables in their
    // exodus-TARGET shape (ISO-8601 timestamps + enum/format CHECK constraints),
    // which the runtime nexus writers cannot use. This drops those and runs the
    // legacy `drizzle-nexus` migrations to recreate them in the runtime shape
    // (plus the FTS5 virtual table + triggers). Idempotent once already-legacy.
    // The consolidated-target cutover + residency move are exodus jobs (T11248 /
    // T11553 / T11538). (T11524)
    establishLegacyNexusSchema(nativeDb, db);

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
