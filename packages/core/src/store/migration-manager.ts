/**
 * Unified migration manager for SQLite databases.
 *
 * Consolidates duplicated reconciliation, bootstrap, retry, and column-safety
 * logic that was previously copy-pasted between sqlite.ts (tasks.db) and
 * memory-sqlite.ts (brain.db). Both modules now delegate to these shared functions.
 *
 * @task T132
 * @see https://github.com/anthropics/cleo/issues/82
 * @see https://github.com/anthropics/cleo/issues/63
 * @see https://github.com/anthropics/cleo/issues/65
 */

import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { MigrationConfig, MigrationMeta } from 'drizzle-orm/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { getLogger } from '../logger.js';
import { isSqliteBusy } from './with-retry.js';

/**
 * Re-export {@link isSqliteBusy} from its canonical home so existing
 * imports like `import { isSqliteBusy } from './migration-manager.js'`
 * and the public re-export chain `sqlite.ts → migration-manager.ts`
 * continue to compile unchanged.
 *
 * The implementation now lives in `./with-retry.ts` (gh#391).
 */
export { isSqliteBusy };

/** Required column definition for ensureColumns(). */
export interface RequiredColumn {
  name: string;
  /** ALTER TABLE ADD COLUMN DDL suffix (e.g., 'text', 'integer DEFAULT 0'). */
  ddl: string;
}

/** Migration retry constants for SQLITE_BUSY handling (T5185). */
const MAX_MIGRATION_RETRIES = 5;
const MIGRATION_RETRY_BASE_DELAY_MS = 100;
const MIGRATION_RETRY_MAX_DELAY_MS = 2000;

/**
 * Strip SQL line (`-- …`) and block (`/* … *​/`) comments from a migration's SQL
 * before scanning it for DDL targets.
 *
 * Migration files routinely carry prose comments describing the change — phrases
 * like "the project-side CREATE TABLE half of that move" or "CREATE TABLE IF NOT
 * EXISTS ensures it exists". A DDL-extraction regex run over the RAW SQL captures
 * bogus "table" names from those comments (`half`, `IF`, `ensures`), making a
 * fully-satisfied migration look un-applied. The journal then omits it, Drizzle
 * re-runs its bare `CREATE TABLE …` against a DB where the table already exists,
 * and the open fails (root cause of the "Task database not initialized" poison).
 *
 * Always strip comments via this helper BEFORE any `createTableRegex` /
 * `createIndexRegex` / `alterColumnRegex` scan. The pair of replaces matches the
 * idiom already used by {@link isExecutableStatement} and Scenario 3's
 * comment-only baseline detection.
 *
 * @param sql - Raw migration SQL (one statement or many joined with `\n`)
 * @returns The SQL with all `--` line comments and `/* … *​/` block comments removed
 */
export function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Compute the set of tables that a migration lineage CREATEs and a LATER
 * migration permanently ELIMINATES (DROP TABLE with no subsequent recreate).
 *
 * ## Why (bug #2)
 *
 * The DDL probe ({@link probeAndMarkApplied}) marks a `CREATE TABLE foo`
 * migration applied only if `foo` exists in the live schema. That breaks when a
 * later migration DROPs `foo` for good: e.g. `t033`/`initial` create
 * `release_manifests`, which `t9686b2` later DROPs (superseded by `releases`).
 * On a DB that has run the WHOLE lineage, `release_manifests` is correctly
 * absent — but the probe then refuses to mark `t033`/`initial` applied, so
 * drizzle's `migrate()` re-runs their bare `CREATE TABLE release_manifests`
 * against the live DB and throws ("table already exists" / cascade) — surfacing
 * as the opaque E_NOT_INITIALIZED / E_INTERNAL on a consolidated `cleo.db`.
 *
 * Pre-computing the eliminated set lets the probe treat a CREATE-of-an-
 * eliminated-table as already satisfied: the table is *supposed* to be gone, so
 * its absence is evidence the lineage ran, not that it didn't.
 *
 * ## Disposition tracking
 *
 * Walks migrations in `folderMillis` order and, WITHIN each migration, processes
 * statements IN ORDER so the SQLite rebuild/recreate idioms resolve correctly:
 *
 *  - `CREATE TABLE x` (or `… RENAME TO x`) → `x` is present.
 *  - `DROP TABLE x`                        → `x` is dropped.
 *
 * The rebuild idiom (`CREATE __new_x; DROP x; ALTER __new_x RENAME TO x`) and the
 * drop-then-recreate idiom (`DROP x; CREATE x`) both end with `x` PRESENT because
 * the final in-order statement for `x` is a create/rename. A table is
 * "eliminated" only if the LAST statement touching it across the whole lineage is
 * a DROP. Transient intermediates (`__new_*`) are naturally classified by the
 * same rule and are irrelevant to the probe (which already redirects renames to
 * the final name).
 *
 * @param migrations - All local migrations of one lineage (from readMigrationFiles)
 * @returns The set of permanently-eliminated final table names
 * @task T11553
 */
export function computeEliminatedTables(
  migrations: ReadonlyArray<{ folderMillis: number; sql?: string | string[] }>,
): Set<string> {
  const createTableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?(\w+)[`"]?/i;
  const dropTableRegex = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?[`"]?(\w+)[`"]?/i;
  const renameRegex = /ALTER\s+TABLE\s+[`"]?(\w+)[`"]?\s+RENAME\s+TO\s+[`"]?(\w+)[`"]?/i;

  // Final disposition per table: true = present, false = dropped.
  const disposition = new Map<string, boolean>();

  const ordered = [...migrations].sort((a, b) => a.folderMillis - b.folderMillis);
  for (const migration of ordered) {
    const statements = Array.isArray(migration.sql) ? migration.sql : [migration.sql ?? ''];
    for (const rawStatement of statements) {
      // Split on `;` so multiple DDL statements joined in one `.sql` array entry
      // are still evaluated IN ORDER (drizzle usually splits on
      // statement-breakpoint, but a migration may carry several `;`-separated
      // statements in a single chunk).
      const stripped = stripSqlComments(rawStatement);
      for (const clause of stripped.split(';')) {
        const create = createTableRegex.exec(clause);
        if (create) {
          disposition.set(create[1] as string, true);
          continue;
        }
        const rename = renameRegex.exec(clause);
        if (rename) {
          disposition.set(rename[2] as string, true);
          continue;
        }
        const drop = dropTableRegex.exec(clause);
        if (drop) {
          disposition.set(drop[1] as string, false);
        }
      }
    }
  }

  const eliminated = new Set<string>();
  for (const [table, present] of disposition) {
    if (!present) eliminated.add(table);
  }
  return eliminated;
}

/**
 * The timestamp-prefix of the consolidation cutover migration
 * (`20260531000001_t11363-consolidation-cleo-{project,global}`), used as the
 * fallback when the consolidation migration cannot be located on disk.
 *
 * Migration folder names start with a 14-char numeric timestamp prefix
 * (`YYYYMMDDHHMMSS`). Comparing those prefixes lexicographically is equivalent
 * to comparing the encoded timestamps, so this string is the cutover boundary.
 *
 * @task T11553
 */
export const CONSOLIDATION_CUTOVER_PREFIX = '20260531000001';

/**
 * Length of a drizzle migration folder's leading `YYYYMMDDHHMMSS` timestamp.
 */
const MIGRATION_TIMESTAMP_PREFIX_LEN = 14;

/**
 * Resolve the consolidation cutover timestamp-prefix for a lineage being
 * reconciled, by locating the `*-consolidation-cleo-*` migration in the SIBLING
 * consolidated folders (`drizzle-cleo-project` / `drizzle-cleo-global`) next to
 * the supplied `migrationsFolder`.
 *
 * The legacy lineages (`drizzle-tasks` / `drizzle-brain`) do NOT themselves
 * contain the consolidation migration — it lives in the consolidated folders —
 * so we scan the siblings. Best-effort: if neither sibling is present/readable
 * (partial install) the function returns {@link CONSOLIDATION_CUTOVER_PREFIX}.
 *
 * @param migrationsFolder - Absolute path to the lineage folder being reconciled
 * @returns The 14-char timestamp prefix of the consolidation cutover migration
 * @task T11553
 */
export function resolveConsolidationCutoverPrefix(migrationsFolder: string): string {
  const parent = dirname(migrationsFolder);
  for (const setName of ['drizzle-cleo-project', 'drizzle-cleo-global']) {
    const folder = join(parent, setName);
    if (!existsSync(folder)) continue;
    try {
      const consolidation = readMigrationFiles({ migrationsFolder: folder }).find((m) =>
        /-consolidation-cleo-/.test(m.name ?? ''),
      );
      if (consolidation?.name) {
        return consolidation.name.slice(0, MIGRATION_TIMESTAMP_PREFIX_LEN);
      }
    } catch {
      // Best-effort — fall through to the next sibling / the constant fallback.
    }
  }
  return CONSOLIDATION_CUTOVER_PREFIX;
}

/**
 * Whether a migration's `YYYYMMDDHHMMSS` timestamp prefix is at or before the
 * consolidation cutover — i.e. it is a PRE-consolidation legacy migration
 * subsumed by the consolidation snapshot (vs a NEW post-consolidation migration
 * that must run normally).
 *
 * @param migrationName - The migration folder name (e.g. `20260321000000_t033-…`)
 * @param cutoverPrefix - The cutover prefix from {@link resolveConsolidationCutoverPrefix}
 * @returns true if at/before the cutover (pre-consolidation), false if after
 * @task T11553
 */
function isAtOrBeforeCutover(migrationName: string | undefined, cutoverPrefix: string): boolean {
  const prefix = (migrationName ?? '').slice(0, MIGRATION_TIMESTAMP_PREFIX_LEN);
  // A name without a parseable prefix is treated as pre-cutover (legacy/unknown):
  // safer to stamp-and-skip than to re-run an unknown legacy migration. Real
  // post-consolidation migrations always carry a valid prefix.
  if (prefix.length < MIGRATION_TIMESTAMP_PREFIX_LEN) return true;
  return prefix <= cutoverPrefix;
}

/**
 * Check whether a table exists in a SQLite database.
 */
export function tableExists(nativeDb: DatabaseSync, tableName: string): boolean {
  const result = nativeDb
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(tableName) as Record<string, unknown> | undefined;
  return !!result;
}

/**
 * Create a pre-migration safety backup of the database file.
 *
 * Only creates the backup once (idempotent). Non-fatal on failure.
 */
export function createSafetyBackup(dbPath: string): void {
  const backupPath = dbPath.replace(/\.db$/, '-pre-cleo.db.bak');
  if (!existsSync(backupPath)) {
    try {
      copyFileSync(dbPath, backupPath);
    } catch {
      /* non-fatal */
    }
  }
}

/**
 * Insert a journal entry including `name` so Drizzle v1 beta (which checks by name,
 * not hash) correctly identifies the migration as already applied.
 *
 * Emits INSERT OR IGNORE to avoid duplicate-row errors when called defensively.
 */
function insertJournalEntry(
  nativeDb: DatabaseSync,
  hash: string,
  createdAt: number,
  name: string,
): void {
  // Ensure the name and applied_at columns exist (Drizzle v1 beta schema).
  // These are added by upgradeSyncIfNeeded, but reconcileJournal may run before
  // the first migrate() call that triggers the upgrade.
  const columns = nativeDb.prepare('PRAGMA table_info("__drizzle_migrations")').all() as Array<{
    name: string;
  }>;
  const colNames = new Set(columns.map((c) => c.name));
  if (!colNames.has('name')) {
    nativeDb.exec('ALTER TABLE "__drizzle_migrations" ADD COLUMN "name" text');
  }
  if (!colNames.has('applied_at')) {
    nativeDb.exec('ALTER TABLE "__drizzle_migrations" ADD COLUMN "applied_at" TEXT');
  }

  nativeDb.exec(
    `INSERT OR IGNORE INTO "__drizzle_migrations" ("hash", "created_at", "name") VALUES ('${hash}', ${createdAt}, '${name}')`,
  );
}

/**
 * Probe a migration's DDL against the live schema and mark the journal entry
 * applied IF AND ONLY IF all DDL targets already exist in the database.
 *
 * Supports three DDL forms commonly emitted by drizzle migrations:
 * - `ALTER TABLE foo ADD COLUMN bar text` → mark applied if column foo.bar exists
 * - `CREATE TABLE foo (...)` → mark applied if table foo exists
 * - `CREATE INDEX [IF NOT EXISTS] idx_foo ON foo(...)` → mark applied if index exists
 *
 * If the migration contains DDL that doesn't fall into these patterns, or if any
 * target is missing, the function returns false and DOES NOT mark applied —
 * leaving the migration for Drizzle's normal `migrate()` to run.
 *
 * Used by:
 * - Scenario 2 Sub-case B (after journal reset, decide what was already applied)
 * - Scenario 3 (originally inline; now extracted for reuse)
 *
 * Replaces the broken "wholesale mark applied" pattern that was the root cause
 * of the ensureColumns band-aid sprawl (T632).
 *
 * ## Eliminated-table tolerance (bug #2 · T11553)
 *
 * A `CREATE TABLE foo` whose `foo` is in `eliminatedTables` — i.e. a LATER
 * migration in the same lineage permanently DROPs it (e.g. `release_manifests`,
 * dropped by `t9686b2`) — is treated as ALREADY SATISFIED. On a DB that ran the
 * whole lineage the table is *supposed* to be absent; without this tolerance the
 * probe refuses to mark the creating migration applied, drizzle re-runs its bare
 * `CREATE TABLE` and throws. See {@link computeEliminatedTables}.
 *
 * ## Zero-DDL discriminator (bug #2 follow-up · T11553)
 *
 * A migration with NO probe-able DDL targets (pure `INSERT`/`UPDATE`/`DELETE`
 * backfill, `DROP TABLE`-only, `CREATE VIEW`, …) cannot be verified by schema
 * inspection. The cutover decides:
 *
 *  - **at/before** the consolidation cutover → a PRE-consolidation legacy
 *    migration, already subsumed and possibly NON-idempotent (`UPDATE`/plain
 *    `INSERT`) → STAMP applied (do NOT re-run).
 *  - **after** the cutover → a NEW post-consolidation migration whose effect has
 *    NOT run yet → do NOT stamp (return false) so drizzle `migrate()` executes
 *    it. New migrations are required to be idempotent (`INSERT OR IGNORE` /
 *    `DROP … IF EXISTS` / `CREATE … IF NOT EXISTS`), so running them is correct
 *    and harmless on re-run; they journal normally afterwards.
 *
 * Migrations WITH DDL targets keep the probe-tolerance behaviour unchanged
 * (including post-cutover ones like t11538/t11649 that must be probe-stampable
 * once already applied).
 *
 * @param nativeDb - Native SQLite database handle
 * @param migration - One entry from drizzle's readMigrationFiles
 * @param logSubsystem - Logger subsystem name
 * @param eliminatedTables - Final table names a later migration permanently DROPs
 *   (from {@link computeEliminatedTables}); their CREATE targets count as
 *   satisfied. Defaults to empty (no tolerance) for callers that do not supply it.
 * @param consolidationCutoverPrefix - The cutover timestamp-prefix from
 *   {@link resolveConsolidationCutoverPrefix}; gates the zero-DDL stamp/run
 *   decision. Defaults to {@link CONSOLIDATION_CUTOVER_PREFIX}.
 * @returns true if the journal entry was inserted; false if migration must run
 */
function probeAndMarkApplied(
  nativeDb: DatabaseSync,
  migration: { hash: string; folderMillis: number; name?: string; sql?: string | string[] },
  logSubsystem: string,
  eliminatedTables: ReadonlySet<string> = new Set(),
  consolidationCutoverPrefix: string = CONSOLIDATION_CUTOVER_PREFIX,
): boolean {
  const sqlStatements = Array.isArray(migration.sql) ? migration.sql : [migration.sql ?? ''];
  // Strip SQL line (`--`) and block (`/* */`) comments BEFORE any DDL-target
  // extraction. Prose comments routinely contain phrases like "the project-side
  // CREATE TABLE half of that move", which would otherwise make createTableRegex
  // capture a phantom target (`half`) → tableExists(phantom) false → the
  // migration is wrongly left un-journaled → Drizzle re-runs its bare CREATE
  // TABLE against an existing table and crashes (root-cause of the
  // "Task database not initialized" poison). Mirrors the same idiom already used
  // by reconcileBrainMigrationsForConsolidatedDb and Scenario 3 below.
  const fullSql = stripSqlComments(sqlStatements.join('\n'));

  // Extract DDL targets we can probe.
  const alterColumnRegex = /ALTER\s+TABLE\s+[`"]?(\w+)[`"]?\s+ADD\s+COLUMN\s+[`"]?(\w+)[`"]?/gi;
  const createTableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?(\w+)[`"]?/gi;
  const createIndexRegex =
    /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?(\w+)[`"]?/gi;
  const createTriggerRegex = /CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?(\w+)[`"]?/gi;

  const alterTargets: Array<{ table: string; column: string }> = [];
  for (const m of fullSql.matchAll(alterColumnRegex)) {
    alterTargets.push({ table: m[1] as string, column: m[2] as string });
  }

  // Build rename map: if migration contains "ALTER TABLE x_new RENAME TO x",
  // record { intermediate: "x_new", final: "x" }. Used below to redirect
  // CREATE TABLE probes away from temporary intermediate tables (which no
  // longer exist after the rename) to the final table name.
  const renameRegex = /ALTER\s+TABLE\s+[`"]?(\w+)[`"]?\s+RENAME\s+TO\s+[`"]?(\w+)[`"]?/gi;
  const renameMap = new Map<string, string>(); // intermediate → final
  for (const m of fullSql.matchAll(renameRegex)) {
    renameMap.set(m[1] as string, m[2] as string);
  }

  // Track which created tables came from the rename map (all _new → final).
  let allCreatedTablesAreRenamed = true;
  const tableTargets: string[] = [];
  for (const m of fullSql.matchAll(createTableRegex)) {
    const created = m[1] as string;
    if (renameMap.has(created)) {
      // Intermediate table renamed → probe the FINAL table name.
      tableTargets.push(renameMap.get(created) as string);
    } else {
      // Table not renamed — genuinely new table, probe its name directly.
      allCreatedTablesAreRenamed = false;
      tableTargets.push(created);
    }
  }

  // For pure rebuild migrations (every CREATE TABLE is an intermediate that was
  // renamed), skip the index probe. Indexes are always recreated as part of the
  // rename idiom; requiring them to pre-exist would make the probe overly strict
  // and would fail in tests (and on freshly-wiped DBs where indexes aren't yet
  // present). The presence of all final table names is sufficient evidence.
  const isRebuildOnlyMigration =
    allCreatedTablesAreRenamed && tableTargets.length > 0 && alterTargets.length === 0;

  // T11280: Any migration that performs a table rebuild/rename (renameMap > 0)
  // recreates that table's indexes as a side-effect of the rebuild idiom. Those
  // recreated indexes can be LEGITIMATELY DROPPED by a LATER migration (e.g.
  // wave0-schema-hardening creates `idx_task_relations_related_to`, which
  // t9519/t10571 subsequently drop when they rebuild `task_relations` with a
  // new primary key). Probing for such an index therefore reports the migration
  // as un-applied even though its DDL ran — causing migrate() to destructively
  // re-run the rebuild and crash on "table sessions already exists".
  //
  // Final-table presence is the only reliable evidence for a rebuild migration,
  // so suppress the fragile index probe whenever the migration renames at least
  // one table — even if it ALSO creates genuinely-new tables (the previous
  // `allCreatedTablesAreRenamed` gate was too narrow). Pure CREATE INDEX
  // migrations (no rename, no rebuild) still probe their indexes normally.
  const performsTableRebuild = renameMap.size > 0;

  // Capture `CREATE INDEX <name> ON <table>` so the probe can skip indexes that
  // live on an ELIMINATED table (bug #2): when `release_manifests` is dropped by
  // a later migration, SQLite drops `idx_release_manifests_*` with it — probing
  // for them would wrongly report the creating migration un-applied.
  const createIndexWithTableRegex =
    /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?(\w+)[`"]?\s+ON\s+[`"]?(\w+)[`"]?/gi;
  const indexOnTable = new Map<string, string>();
  for (const m of fullSql.matchAll(createIndexWithTableRegex)) {
    indexOnTable.set(m[1] as string, m[2] as string);
  }

  const indexTargets: string[] = [];
  if (!isRebuildOnlyMigration && !performsTableRebuild) {
    for (const m of fullSql.matchAll(createIndexRegex)) {
      const idx = m[1] as string;
      // Skip indexes on a permanently-eliminated table — they are expected to be
      // gone once that table was dropped.
      if (eliminatedTables.has(indexOnTable.get(idx) ?? '')) continue;
      indexTargets.push(idx);
    }
  }

  const triggerTargets: string[] = [];
  for (const m of fullSql.matchAll(createTriggerRegex)) {
    triggerTargets.push(m[1] as string);
  }

  const totalTargets =
    alterTargets.length + tableTargets.length + indexTargets.length + triggerTargets.length;
  if (totalTargets === 0) {
    // No probe-able DDL — pure DML (INSERT/UPDATE/DELETE), DROP-only, CREATE VIEW,
    // etc. Schema inspection can't verify it, so the consolidation cutover decides
    // (bug #2 follow-up · T11553):
    if (isAtOrBeforeCutover(migration.name, consolidationCutoverPrefix)) {
      // PRE-consolidation legacy migration — already subsumed by the consolidation
      // snapshot and possibly NON-idempotent (UPDATE / plain INSERT). Re-running it
      // would double-apply or fail, so STAMP applied without running.
      insertJournalEntry(nativeDb, migration.hash, migration.folderMillis, migration.name ?? '');
      getLogger(logSubsystem).debug(
        { migration: migration.name },
        `Zero-DDL pre-consolidation migration ${migration.name} stamped applied (subsumed; not re-run).`,
      );
      return true;
    }
    // POST-consolidation migration (e.g. a new INSERT-OR-IGNORE backfill or
    // DROP-IF-EXISTS) whose effect has NOT run yet — DO NOT stamp; let drizzle
    // migrate() execute it. New migrations are required to be idempotent.
    return false;
  }

  // Probe each target.
  const allAltersPresent = alterTargets.every(({ table, column }) => {
    if (!tableExists(nativeDb, table)) return false;
    const cols = nativeDb.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    return cols.some((c) => c.name === column);
  });
  // A CREATE-TABLE target is satisfied if it exists OR if a later migration in
  // the lineage permanently eliminated it (bug #2 — e.g. `release_manifests`,
  // dropped by t9686b2). Its absence on a fully-migrated DB is expected.
  const allTablesPresent = tableTargets.every(
    (t) => tableExists(nativeDb, t) || eliminatedTables.has(t),
  );
  const allIndexesPresent = indexTargets.every((idx) => {
    const rows = nativeDb
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`)
      .all(idx) as Array<{ name: string }>;
    return rows.length > 0;
  });
  const allTriggersPresent = triggerTargets.every((trg) => {
    const rows = nativeDb
      .prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name=?`)
      .all(trg) as Array<{ name: string }>;
    return rows.length > 0;
  });

  if (allAltersPresent && allTablesPresent && allIndexesPresent && allTriggersPresent) {
    insertJournalEntry(nativeDb, migration.hash, migration.folderMillis, migration.name ?? '');
    const log = getLogger(logSubsystem);
    log.debug(
      {
        migration: migration.name,
        alters: alterTargets.length,
        tables: tableTargets.length,
        indexes: indexTargets.length,
        isRebuildOnly: isRebuildOnlyMigration,
      },
      `Migration ${migration.name} DDL already present in schema — marked applied.`,
    );
    return true;
  }

  // At least one target missing — leave for drizzle migrate() to run.
  return false;
}

/**
 * Read the set of migration hashes for a SIBLING lineage folder (T11829).
 *
 * Used to build the cross-lineage orphan-deletion union in {@link reconcileJournal}.
 * Defensive: a missing/unreadable/empty sibling folder yields an empty set rather
 * than throwing — a sibling that does not exist in this install simply contributes
 * no hashes to the union (the reconcile is conservative: fewer known hashes can
 * only mean MORE deletions, so we never over-delete by failing safe to empty, but
 * we also never crash the caller's open on a missing sibling).
 *
 * @param siblingFolder - Absolute path to a sibling drizzle migrations folder.
 * @returns The set of migration hashes declared by that folder (empty on failure).
 */
function readSiblingMigrationHashes(siblingFolder: string): Set<string> {
  try {
    return new Set(readMigrationFiles({ migrationsFolder: siblingFolder }).map((m) => m.hash));
  } catch {
    return new Set();
  }
}

/**
 * Ensure a UNIQUE index on `__drizzle_migrations(hash)` exists so the shared
 * consolidated journal converges idempotently (T11829).
 *
 * With the UNIQUE index in place, the `INSERT OR IGNORE` emitted by
 * {@link insertJournalEntry} becomes a true no-op on a re-probe (rather than
 * appending a duplicate row), so any residual cross-lineage re-probe cannot grow
 * the journal. Creation is guarded behind a one-time dedup: the live consolidated
 * journal currently has no duplicate hashes, but a historically-thrashed journal
 * could, and `CREATE UNIQUE INDEX` would fail on duplicates. We therefore collapse
 * any duplicate-hash rows (keeping the lowest `id`) BEFORE creating the index.
 *
 * Idempotent and cheap: once the index exists, `CREATE UNIQUE INDEX IF NOT EXISTS`
 * is a no-op and the dedup pass finds nothing.
 *
 * @param nativeDb - Native SQLite database handle.
 */
function ensureJournalHashUnique(nativeDb: DatabaseSync): void {
  if (!tableExists(nativeDb, '__drizzle_migrations')) return;
  try {
    // One-time dedup: keep the lowest id per hash, delete the rest. A no-op once
    // the journal is already unique (the live journal has no dups today).
    nativeDb.exec(
      'DELETE FROM "__drizzle_migrations" WHERE id NOT IN ' +
        '(SELECT MIN(id) FROM "__drizzle_migrations" GROUP BY hash)',
    );
    nativeDb.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS "idx_drizzle_migrations_hash" ON "__drizzle_migrations" ("hash")',
    );
  } catch {
    // Best-effort convergence aid — never block an open on the index/dedup.
    // INSERT OR IGNORE already guards duplicate inserts at the row level even
    // without the index (it just cannot enforce uniqueness without it).
  }
}

/**
 * Bootstrap and reconcile the Drizzle migration journal.
 *
 * Handles four scenarios:
 * 1. Tables exist but no __drizzle_migrations — bootstrap baseline as applied
 * 2. Journal has orphaned hashes (from older CLEO version) — clear and re-mark all as applied
 * 3. Journal exists but is missing entries for migrations whose DDL has already been applied
 *    (e.g., ALTER TABLE ADD COLUMN ran but journal entry was never written — happens when
 *    migrations are cherry-picked from worktrees or the process crashes mid-migration).
 *    Auto-inserts the missing journal entry so Drizzle skips the migration instead of
 *    re-running ALTER TABLE and crashing on "duplicate column name".
 * 4. Journal entries exist but have null `name` — Drizzle v1 beta identifies applied
 *    migrations by name, so entries without a name are invisible to it, causing already-
 *    applied migrations to be re-run and fail with "duplicate column name". Backfills
 *    the name from the local migration file matched by hash.
 *
 * ## Cross-lineage orphan-deletion guard (T11829 — OOM root fix)
 *
 * The consolidated `cleo.db` carries ONE shared `__drizzle_migrations` journal but
 * is reconciled by MULTIPLE physically-coexisting migration lineages
 * (`drizzle-tasks`, `drizzle-cleo-project`, `drizzle-nexus`, `drizzle-brain`,
 * `drizzle-agent-registry`, `drizzle-conduit`). Each lineage only knows its OWN
 * folder, so a naive Sub-case B classified EVERY sibling lineage's journal rows as
 * "true orphans" and DELETEd them — the next sibling open then deleted THIS
 * lineage's rows, so the journal NEVER converged (it oscillated and re-ran
 * BEGIN/COMMIT migrate transactions on every open, holding the WAL writer lock and
 * stacking 300-550 MB-per-connection opens until the host OOM-killed).
 *
 * The fix: an entry is a TRUE orphan only when its hash belongs to NO lineage that
 * physically shares this DB. Callers that share the journal pass
 * `siblingMigrationsFolders` (the OTHER lineages' folders); the orphan-DELETE
 * decision then uses the UNION of every sibling lineage's hashes plus this
 * lineage's own. A hash present in any sibling is preserved (it is that sibling's
 * legitimately-applied migration, not an orphan). Standalone DBs (a single
 * lineage) pass no siblings and behave exactly as before.
 *
 * @param nativeDb - Native SQLite database handle
 * @param migrationsFolder - Path to the drizzle migrations folder
 * @param existenceTable - A table name used to detect if the DB has data (e.g., 'tasks' or 'brain_decisions')
 * @param logSubsystem - Logger subsystem name for reconciliation warnings
 * @param siblingMigrationsFolders - OTHER migration-lineage folders that share this
 *   `__drizzle_migrations` journal inside the same consolidated `cleo.db` (T11829).
 *   Their hashes are added to the orphan-deletion union so a sibling lineage's rows
 *   are never deleted as cross-lineage orphans. Omit (or pass `[]`) for a DB with a
 *   single lineage. Unreadable/empty sibling folders are skipped defensively.
 */
export function reconcileJournal(
  nativeDb: DatabaseSync,
  migrationsFolder: string,
  existenceTable: string,
  logSubsystem: string,
  siblingMigrationsFolders: readonly string[] = [],
): void {
  // bug #2 (T11553): pre-compute the tables this lineage CREATEs and a LATER
  // migration permanently ELIMINATES (DROP TABLE, no recreate — e.g.
  // `release_manifests`, dropped by t9686b2). The DDL probe treats a CREATE of an
  // eliminated table (and its indexes) as already satisfied, so a fully-migrated
  // DB — where that table is correctly absent — doesn't make drizzle re-run the
  // creating migration's bare `CREATE TABLE` and crash.
  const eliminatedTables = computeEliminatedTables(readMigrationFiles({ migrationsFolder }));

  // bug #2 follow-up (T11553): the consolidation cutover timestamp-prefix gates
  // the zero-DDL stamp/run decision in probeAndMarkApplied — pre-cutover legacy
  // DML/DROP migrations are stamped (subsumed, possibly non-idempotent), new
  // post-cutover ones are left for migrate() to RUN. Resolved from the sibling
  // consolidation migration on disk.
  const cutoverPrefix = resolveConsolidationCutoverPrefix(migrationsFolder);

  // Scenario 1: Tables exist but no migration journal — bootstrap baseline
  if (tableExists(nativeDb, existenceTable) && !tableExists(nativeDb, '__drizzle_migrations')) {
    const migrations = readMigrationFiles({ migrationsFolder });
    const baseline = migrations[0];
    if (baseline) {
      nativeDb.exec(`
        CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
          id INTEGER PRIMARY KEY,
          hash text NOT NULL,
          created_at numeric,
          name text,
          applied_at TEXT
        )
      `);
      insertJournalEntry(nativeDb, baseline.hash, baseline.folderMillis, baseline.name ?? '');
    }
  }

  // T11829: enforce UNIQUE(hash) so the shared consolidated journal converges
  // idempotently — any residual re-probe's INSERT OR IGNORE becomes a true no-op.
  // Runs once the journal table exists (Scenario 1 / a prior open created it).
  ensureJournalHashUnique(nativeDb);

  // Scenario 2: Journal has orphaned entries from a previous CLEO version
  //
  // Two distinct sub-cases require different handling:
  //
  // A) DB is AHEAD of this install (forward-compatibility): all local hashes
  //    are present in the DB, but the DB also has additional entries for
  //    migrations this install does not know about. This happens when a user
  //    runs a globally-installed (older) cleo binary against a DB that was
  //    last written by a newer cleo version. Deleting those entries would
  //    cause an infinite reconciliation cycle: Drizzle re-runs the "missing"
  //    migrations, hits duplicate-column errors (Scenario 3 recovers), writes
  //    them back — only for this install to delete them again on the next run.
  //    ACTION: skip reconciliation, log at debug only.
  //
  // B) TRUE ORPHANS — orphan entries that do not correspond to any local
  //    migration hash (the migration file was removed from disk, or the journal
  //    is from a fundamentally different cleo lineage). ACTION: delete the
  //    orphaned entries and re-probe local migrations via DDL.
  //
  // NOTE (T11528): the former hash-drift sub-case — which UPDATEd a journal
  // entry's hash in place when its NAME matched a local migration but its hash
  // differed — was removed once all DDL became owned by immutable Drizzle
  // forward migrations (v1.0.0-rc.3 contract, E6 L1-L7). Migrations are no
  // longer edited post-release, so name-matched hash drift can no longer occur;
  // any remaining orphan is a true orphan handled by Sub-case B below.
  if (tableExists(nativeDb, '__drizzle_migrations') && tableExists(nativeDb, existenceTable)) {
    const localMigrations = readMigrationFiles({ migrationsFolder });
    const localHashes = new Set(localMigrations.map((m) => m.hash));

    // T11829 (OOM root fix): the orphan-DELETE decision must use the UNION of
    // every migration lineage that physically shares this DB's `__drizzle_migrations`
    // journal — NOT just this lineage's folder. A hash belonging to a sibling
    // lineage (e.g. drizzle-cleo-project's rows seen from the drizzle-tasks open)
    // is that sibling's legitimately-applied migration, not an orphan. Deleting it
    // is what made the shared journal oscillate and never converge → host OOM.
    const knownHashes = new Set(localHashes);
    for (const siblingFolder of siblingMigrationsFolders) {
      if (siblingFolder === migrationsFolder) continue;
      for (const m of readSiblingMigrationHashes(siblingFolder)) {
        knownHashes.add(m);
      }
    }

    type JournalRow = { id: number; hash: string };
    const dbEntries = nativeDb
      .prepare('SELECT id, hash FROM "__drizzle_migrations"')
      .all() as JournalRow[];

    // A row is an orphan ONLY when its hash is unknown to THIS lineage AND every
    // sibling lineage sharing this journal (T11829 cross-lineage guard).
    const orphanedEntries = dbEntries.filter((e) => !knownHashes.has(e.hash));
    const hasOrphanedEntries = orphanedEntries.length > 0;

    if (hasOrphanedEntries) {
      const dbHashes = new Set(dbEntries.map((e) => e.hash));
      const allLocalHashesPresentInDb = localMigrations.every((m) => dbHashes.has(m.hash));

      const log = getLogger(logSubsystem);

      if (allLocalHashesPresentInDb) {
        // Sub-case A: DB is ahead — this install is older than the DB.
        // Do NOT modify the journal; log at debug so we can trace if needed.
        log.debug(
          { extra: orphanedEntries.length },
          `Migration journal has ${orphanedEntries.length} entries for migrations not known to this install (DB is ahead). Skipping reconciliation.`,
        );
      } else {
        // Sub-case B: TRUE ORPHANS — entries whose hash matches NO known lineage
        // (this one or any sibling sharing the journal). Delete them and re-probe
        // local migrations via DDL.
        log.warn(
          { orphaned: orphanedEntries.length },
          `Detected ${orphanedEntries.length} true-orphan journal entries from a previous CLEO lineage. Reconciling via DDL probe.`,
        );
        const deleteStmt = nativeDb.prepare('DELETE FROM "__drizzle_migrations" WHERE id = ?');
        for (const e of orphanedEntries) deleteStmt.run(e.id);
        // Re-probe local migrations that may now have no journal entry.
        // The selective delete above keeps every applied migration journaled,
        // so the probe only inserts entries for genuinely missing ones.
        const journaledHashesAfter = new Set(
          (
            nativeDb.prepare('SELECT hash FROM "__drizzle_migrations"').all() as Array<{
              hash: string;
            }>
          ).map((r) => r.hash),
        );
        for (const m of localMigrations) {
          if (journaledHashesAfter.has(m.hash)) continue;
          probeAndMarkApplied(nativeDb, m, logSubsystem, eliminatedTables, cutoverPrefix);
        }
      }
    }
  }

  // Scenario 3: Journal exists but is missing entries for already-applied migrations.
  // Detects migrations whose DDL columns already exist in the database but whose
  // journal entry was never written (e.g., cherry-picked from a worktree, or process
  // crashed after the ALTER TABLE succeeded but before the journal INSERT committed).
  //
  // T920: Extended to handle PARTIAL application — when SOME ALTER targets exist but
  // not all (e.g., T528 where brain_page_nodes ALTERs ran but brain_page_edges.provenance
  // did not). In this case the migration also has DROP TABLE + CREATE TABLE statements,
  // so the full migration cannot be re-run (the existing columns cause duplicate-column
  // errors). Fix: add any missing ALTER columns via idempotent ALTER TABLE, then mark
  // the migration as applied so Drizzle skips it.
  if (tableExists(nativeDb, '__drizzle_migrations') && tableExists(nativeDb, existenceTable)) {
    const localMigrations = readMigrationFiles({ migrationsFolder });
    const journalEntries = nativeDb
      .prepare('SELECT hash FROM "__drizzle_migrations"')
      .all() as Array<{ hash: string }>;
    const journaledHashes = new Set(journalEntries.map((e) => e.hash));

    for (const migration of localMigrations) {
      if (journaledHashes.has(migration.hash)) continue;

      // Parse the migration SQL for ALTER TABLE ... ADD COLUMN statements.
      // drizzle's readMigrationFiles returns sql as string[] (one entry per
      // statement-breakpoint-separated statement), so join them for regex scanning.
      const alterColumnRegex =
        /ALTER\s+TABLE\s+[`"]?(\w+)[`"]?\s+ADD\s+COLUMN\s+[`"]?(\w+)[`"]?\s*(.*?)(?:;|$)/gi;
      const alterMatches: Array<{ table: string; column: string; ddl: string }> = [];
      const sqlStatements = Array.isArray(migration.sql) ? migration.sql : [migration.sql ?? ''];
      const fullSql = sqlStatements.join('\n');
      for (const m of fullSql.matchAll(alterColumnRegex)) {
        alterMatches.push({
          table: m[1] as string,
          column: m[2] as string,
          ddl: ((m[3] as string) || '').trim(),
        });
      }

      // Only auto-reconcile migrations that have at least one ALTER TABLE ADD COLUMN,
      // or that use the rename-via-drop+create idiom (CREATE TABLE x_new ... DROP TABLE x
      // ... ALTER TABLE x_new RENAME TO x). Pure CREATE INDEX / DROP INDEX migrations
      // that have no journal entry are genuinely pending and must run normally.
      //
      // T1135: Migrations using only the table-rebuild/rename idiom (no ADD COLUMN) were
      // previously skipped here, leaving them unjournaled and causing Drizzle to re-run
      // them destructively on every init. Delegate to probeAndMarkApplied which handles
      // the RENAME TO pattern and probes the final table name instead of the intermediate.
      //
      // NOTE (T1158): This rename+create branch is NOT dead code after the T1126 folder
      // dedup. It is required for T033 (20260321000000_t033-connection-health) which uses
      // the SQLite table-rebuild/rename idiom (CREATE TABLE tasks_new → RENAME TO tasks).
      // Removing it causes T033 to be omitted from the journal on init, Drizzle re-runs
      // the migration, the tasks table is dropped/recreated without T944 role/scope columns,
      // and downstream INSERTs fail with "table tasks has no column named role".
      //
      // T1165 (Hybrid Path A+ baseline marker): A comment-only migration.sql (no DDL at all,
      // only SQL comment lines) is the probe-and-skip baseline marker introduced by T1165.
      // On existing populated DBs the schema already matches the baseline snapshot — there
      // is nothing to apply. Mark the journal entry immediately so Drizzle skips it rather
      // than running the comment SQL. The "all DDL targets present" check reduces to:
      // strip comments → empty string → no targets at all → baseline already satisfied.
      if (alterMatches.length === 0) {
        // Check for comment-only baseline marker: strip SQL line + block comments
        // (shared {@link stripSqlComments} helper), then check if any
        // non-whitespace DDL remains.
        const stripped = stripSqlComments(fullSql).trim();
        if (stripped === '') {
          // Comment-only baseline marker — mark applied immediately on existing DBs.
          const log = getLogger(logSubsystem);
          log.debug(
            { migration: migration.name },
            `Migration ${migration.name} is a comment-only baseline marker — marking applied on existing DB.`,
          );
          insertJournalEntry(
            nativeDb,
            migration.hash,
            migration.folderMillis,
            migration.name ?? '',
          );
          continue;
        }

        const renameRe = /ALTER\s+TABLE\s+[`"]?\w+[`"]?\s+RENAME\s+TO\s+[`"]?\w+[`"]?/i;
        const createTableRe = /CREATE\s+TABLE/i;
        const createTriggerRe = /CREATE\s+TRIGGER/i;
        if (renameRe.test(fullSql) && createTableRe.test(fullSql)) {
          probeAndMarkApplied(nativeDb, migration, logSubsystem, eliminatedTables, cutoverPrefix);
        } else if (createTableRe.test(fullSql) || createTriggerRe.test(fullSql)) {
          // Pure CREATE TABLE migration (no ALTER, no RENAME). Delegate to
          // probeAndMarkApplied which checks if all CREATE TABLE targets already
          // exist in the schema and marks the migration applied if so.
          // This handles signaldock's initial migration (pure schema bootstrap) when
          // the DB has tables but the journal entry is missing (e.g., after a journal
          // reset or bare-SQL-to-drizzle migration path upgrade).
          probeAndMarkApplied(nativeDb, migration, logSubsystem, eliminatedTables, cutoverPrefix);
        } else {
          // Zero-DDL migration (pure DML backfill, DROP-only, CREATE VIEW, …) with
          // no journal entry. Delegate to probeAndMarkApplied, whose zero-target
          // path applies the consolidation cutover (T11553): a PRE-cutover legacy
          // migration is stamped (subsumed, possibly non-idempotent), while a NEW
          // POST-cutover one is left un-stamped so drizzle migrate() RUNS its
          // effect (e.g. the cutover agent's INSERT-OR-IGNORE backfill / DROP).
          probeAndMarkApplied(nativeDb, migration, logSubsystem, eliminatedTables, cutoverPrefix);
        }
        continue;
      }

      // Check which ADD COLUMN targets already exist and which are missing.
      const existingColumns: Array<{ table: string; column: string; ddl: string }> = [];
      const missingColumns: Array<{ table: string; column: string; ddl: string }> = [];

      for (const target of alterMatches) {
        if (!tableExists(nativeDb, target.table)) {
          missingColumns.push(target);
          continue;
        }
        const cols = nativeDb.prepare(`PRAGMA table_info(${target.table})`).all() as Array<{
          name: string;
        }>;
        if (cols.some((c) => c.name === target.column)) {
          existingColumns.push(target);
        } else {
          missingColumns.push(target);
        }
      }

      // Case A: All ALTER targets already exist — mark as applied (original behaviour).
      if (missingColumns.length === 0) {
        const log = getLogger(logSubsystem);
        log.warn(
          { migration: migration.name, columns: alterMatches },
          `Detected partially-applied migration ${migration.name} — columns exist but journal entry missing. Auto-reconciling.`,
        );
        insertJournalEntry(nativeDb, migration.hash, migration.folderMillis, migration.name ?? '');
        continue;
      }

      // Case B (T920): SOME columns exist but others are missing — the migration was
      // partially applied. If at least one column already exists from this migration's
      // ALTER TABLE set, Drizzle cannot re-run the migration (the existing columns cause
      // "duplicate column name"). Idempotently add the missing columns, then mark applied.
      //
      // We do NOT attempt to run DROP TABLE / CREATE TABLE statements from the migration
      // (e.g., T528's brain_page_edges table recreation for weight NOT NULL), because
      // the table already has data-compatible columns from the partial apply. The
      // ensureColumns call in memory-sqlite.ts provides any remaining structural safety net.
      if (existingColumns.length > 0 && missingColumns.length > 0) {
        const log = getLogger(logSubsystem);
        log.warn(
          {
            migration: migration.name,
            existingColumns: existingColumns.map((c) => `${c.table}.${c.column}`),
            missingColumns: missingColumns.map((c) => `${c.table}.${c.column}`),
          },
          `T920: Detected partial migration ${migration.name} — some ALTER columns exist, some missing. Adding missing columns and marking applied.`,
        );

        // Add each missing column only if its table exists (guard against DROP TABLE
        // mid-migration removing the table entirely).
        for (const { table, column, ddl } of missingColumns) {
          if (!tableExists(nativeDb, table)) continue;
          try {
            nativeDb.exec(`ALTER TABLE ${table} ADD COLUMN ${column}${ddl ? ` ${ddl}` : ''}`);
            log.warn(
              { migration: migration.name, table, column },
              `T920: Added missing column ${table}.${column} to complete partial migration.`,
            );
          } catch {
            // Column add failed (e.g., NOT NULL without default on non-empty table).
            // Log and continue — the subsequent migrate() call may still succeed or
            // fall through to the duplicate-column retry handler.
            log.warn(
              { migration: migration.name, table, column },
              `T920: Could not add missing column ${table}.${column} — will let Drizzle migrate() handle it.`,
            );
          }
        }

        insertJournalEntry(nativeDb, migration.hash, migration.folderMillis, migration.name ?? '');
      }
    }
  }

  // Scenario 4: Journal entries exist but have null `name`.
  //
  // Drizzle v1 beta changed getMigrationsToRun to filter by `name` (not hash).
  // Journal entries inserted by older CLEO code (INSERT without "name") have
  // name = null, which Drizzle filters out — making it treat those migrations as
  // unapplied and re-run them. This causes "duplicate column name" failures for
  // migrations whose DDL has already been applied.
  //
  // Fix: backfill `name` for any journal entries that have name = null but whose
  // hash matches a known local migration file.
  if (tableExists(nativeDb, '__drizzle_migrations') && tableExists(nativeDb, existenceTable)) {
    // Check if the name column exists before querying it
    const migCols = nativeDb.prepare('PRAGMA table_info("__drizzle_migrations")').all() as Array<{
      name: string;
    }>;
    const hasMigNameCol = migCols.some((c) => c.name === 'name');
    if (!hasMigNameCol) return; // name column absent — upgradeSyncIfNeeded will handle it

    const localMigrations = readMigrationFiles({ migrationsFolder });
    const hashToName = new Map(localMigrations.map((m) => [m.hash, m.name ?? '']));

    const unnamedEntries = nativeDb
      .prepare('SELECT id, hash FROM "__drizzle_migrations" WHERE name IS NULL')
      .all() as Array<{ id: number; hash: string }>;

    for (const entry of unnamedEntries) {
      const migrationName = hashToName.get(entry.hash);
      if (!migrationName) continue; // orphaned entry — leave for Scenario 2

      const log = getLogger(logSubsystem);
      // Debug-level: this is an expected one-shot backfill for legacy DBs whose
      // __drizzle_migrations entries were written by older Drizzle versions
      // before the name column existed. Harmless and idempotent — once names
      // are populated this never fires again.
      log.debug(
        { id: entry.id, hash: entry.hash, name: migrationName },
        `Backfilling missing name on journal entry id=${entry.id} (Drizzle v1 beta legacy compat).`,
      );
      nativeDb.exec(
        `UPDATE "__drizzle_migrations" SET "name" = '${migrationName}' WHERE id = ${entry.id}`,
      );
    }
  }
}

/**
 * Reconcile + apply the standalone `drizzle-brain` migrations against a CONSOLIDATED
 * `cleo.db` whose prefixed `brain_*` tables were already created by the
 * consolidated migration (T11647). For each not-yet-journaled `drizzle-brain`
 * migration, this either:
 *
 *  1. **Marks it applied without running** when its net effect is ALREADY present:
 *     every `CREATE TABLE` / `RENAME TO` result table exists, OR it is an
 *     ALTER-ADD-COLUMN-only migration whose columns all already exist (the
 *     consolidated migration created the prefixed tables with their FINAL
 *     columns). This avoids the `CREATE TABLE`/rename collisions and
 *     "duplicate column" errors a wholesale re-run would hit.
 *  2. **Executes it directly** (native `exec`, then journals it) when it is
 *     genuinely missing — the UNPREFIXED legacy runtime tables (`deriver_queue`,
 *     `sticky_tags`, `session_narrative`, `brain_task_observations`) the
 *     consolidated migration omits but the runtime queries. Those migrations are
 *     all `IF NOT EXISTS` DDL + idempotent `INSERT OR IGNORE` backfills, so a
 *     direct exec is safe.
 *
 * ## Why NOT {@link reconcileJournal} + drizzle `migrate()`
 *
 * The brain `__drizzle_migrations` journal is SHARED with the TASKS domain inside
 * the same consolidated `cleo.db`. On a first consolidated open the brain hashes
 * are not yet journaled, so `reconcileJournal`'s Scenario-2 path classifies the
 * TASKS-domain hashes as "orphans" of the brain migration set and DELETES them —
 * which forces the tasks domain to re-run its table-rebuild migrations on the
 * NEXT tasks open and crash (`tasks_new RENAME TO tasks` fires the
 * `task_relations_non_containment_insert` trigger against a mid-rebuild `tasks`).
 * And drizzle's `migrate()` wraps the brain DDL in a `BEGIN`/`COMMIT` over the
 * shared handle. This function is **additive-only** (it never deletes a journal
 * row) and uses plain `nativeDb.exec()`, so it cannot corrupt the shared journal
 * or engage the cross-domain transaction.
 *
 * Idempotent: dedups by hash (the journal has no UNIQUE on `hash`, so an explicit
 * presence check is required). On a brand-new / standalone `brain.db` (no
 * prefixed brain tables yet) every migration is "genuinely missing" and is
 * executed in order — equivalent to a full migrate.
 *
 * @param nativeDb - Native SQLite handle (the consolidated `cleo.db`).
 * @param migrationsFolder - The `drizzle-brain` migrations folder.
 * @returns `{ marked, applied }` — counts of migrations journaled-without-running
 *   vs executed-and-journaled.
 *
 * @task T11647
 */
export function reconcileBrainMigrationsForConsolidatedDb(
  nativeDb: DatabaseSync,
  migrationsFolder: string,
): { marked: number; applied: number } {
  nativeDb.exec(`
    CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
      id INTEGER PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric,
      name text,
      applied_at TEXT
    )
  `);
  const localMigrations = sanitizeMigrationStatements(readMigrationFiles({ migrationsFolder }));
  const existingHashes = new Set(
    (
      nativeDb.prepare('SELECT hash FROM "__drizzle_migrations"').all() as Array<{ hash: string }>
    ).map((r) => r.hash),
  );
  // bug #2 (T11553): tables this brain lineage CREATEs and a LATER migration
  // permanently ELIMINATES — their absence is expected on a fully-migrated DB and
  // must count as "satisfied" so the creating migration is journaled rather than
  // re-run. (Mirrors the reconcileJournal eliminated-table tolerance.)
  const eliminatedTables = computeEliminatedTables(localMigrations);
  const createTableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?(\w+)[`"]?/gi;
  const renameRegex = /ALTER\s+TABLE\s+[`"]?(\w+)[`"]?\s+RENAME\s+TO\s+[`"]?(\w+)[`"]?/gi;
  const addColumnRegex = /ALTER\s+TABLE\s+[`"]?(\w+)[`"]?\s+ADD\s+COLUMN\s+[`"]?(\w+)[`"]?/gi;
  const columnExists = (table: string, column: string): boolean => {
    if (!tableExists(nativeDb, table)) return false;
    const cols = nativeDb.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
    return cols.some((c) => c.name === column);
  };
  // Strip SQL comments before scanning for DDL targets (shared module helper —
  // see {@link stripSqlComments}). A migration's prose comments routinely contain
  // phrases like "CREATE TABLE IF NOT EXISTS ensures it exists", which would
  // otherwise make the CREATE-TABLE regex capture bogus "table" names and wrongly
  // classify a satisfied migration as missing.
  let marked = 0;
  let applied = 0;
  for (const m of localMigrations) {
    if (existingHashes.has(m.hash)) continue;
    const fullSql = stripSqlComments(m.sql.join('\n'));
    // Follow the SQLite table-rebuild/rename idiom (`CREATE TABLE x_new …; ALTER
    // TABLE x_new RENAME TO x`): the migration's RESULT table is the FINAL name,
    // not the transient intermediate.
    const renameMap = new Map<string, string>();
    const renameFinals: string[] = [];
    for (const match of fullSql.matchAll(renameRegex)) {
      renameMap.set(match[1] as string, match[2] as string);
      renameFinals.push(match[2] as string);
    }
    const resultTables = new Set<string>(renameFinals);
    for (const match of fullSql.matchAll(createTableRegex)) {
      const created = match[1] as string;
      resultTables.add(renameMap.get(created) ?? created);
    }
    const addColumns: Array<{ table: string; column: string }> = [];
    for (const match of fullSql.matchAll(addColumnRegex)) {
      addColumns.push({ table: match[1] as string, column: match[2] as string });
    }

    const tablesSatisfied =
      resultTables.size > 0 &&
      [...resultTables].every((t) => tableExists(nativeDb, t) || eliminatedTables.has(t));
    const altersSatisfied =
      resultTables.size === 0 &&
      addColumns.length > 0 &&
      addColumns.every(({ table, column }) => columnExists(table, column));

    if (tablesSatisfied || altersSatisfied) {
      // Net effect (table/columns) already present — journal without re-running
      // the table/column DDL. BUT first replay any `CREATE [UNIQUE] INDEX IF NOT
      // EXISTS` statements the migration carries: the consolidated migration may
      // create a prefixed table with a DIFFERENT (incomplete) index set than the
      // legacy `drizzle-brain` lineage. A missing UNIQUE index is not cosmetic —
      // e.g. `idx_transcript_events_session_seq` powers the
      // `brain_transcript_events` re-ingest dedup; without it, INSERT-OR-IGNORE
      // re-inserts duplicates. `CREATE … INDEX IF NOT EXISTS` is idempotent (a
      // no-op when the index already exists), so replaying them is safe and
      // closes any consolidated-vs-runtime index drift.
      for (const statement of m.sql) {
        // Only replay pure `CREATE [UNIQUE] INDEX IF NOT EXISTS` statements (after
        // stripping any leading comment). A statement that ALSO contains other
        // DDL (CREATE TABLE / ALTER) is skipped — re-running those would collide.
        const stripped = stripSqlComments(statement).trim();
        if (
          /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS/i.test(stripped) &&
          !/CREATE\s+TABLE|ALTER\s+TABLE/i.test(stripped)
        ) {
          nativeDb.exec(statement);
        }
      }
      insertJournalEntry(nativeDb, m.hash, m.folderMillis, m.name ?? '');
      existingHashes.add(m.hash);
      marked++;
      continue;
    }

    // Genuinely missing (an unprefixed runtime table the consolidated migration
    // omits) — execute its statements directly, then journal it. These migrations
    // are `IF NOT EXISTS` DDL + idempotent backfills, safe to native-exec.
    for (const statement of m.sql) {
      nativeDb.exec(statement);
    }
    insertJournalEntry(nativeDb, m.hash, m.folderMillis, m.name ?? '');
    existingHashes.add(m.hash);
    applied++;
  }
  return { marked, applied };
}

/**
 * Collect the `.message` of an Error and every nested `.cause` (recursively).
 *
 * Drizzle wraps the underlying node:sqlite error in a `DrizzleError` whose own
 * `.message` is generic ("Failed to run the query …") while the real SQLite
 * message ("table nexus_nodes already exists") lives in `.cause.message`. Error
 * predicates that only test the top-level `.message` miss the wrapped case and
 * rethrow — defeating the migrateWithRetry reconcile path. Walking the cause
 * chain (with a depth guard against pathological cycles) lets the predicates see
 * the real message regardless of how many layers wrap it.
 *
 * @param err - The thrown value (Error, wrapped Error, or anything else)
 * @returns All messages found along the cause chain, joined with `\n`
 */
function collectErrorMessages(err: unknown): string {
  const messages: string[] = [];
  let current: unknown = err;
  // Depth guard: cap the walk so a self-referential cause cannot loop forever.
  for (let depth = 0; current instanceof Error && depth < 16; depth++) {
    messages.push(current.message);
    current = (current as { cause?: unknown }).cause;
  }
  return messages.join('\n');
}

/**
 * Check whether an error is a SQLite "duplicate column name" error.
 *
 * These are thrown when an ALTER TABLE ADD COLUMN statement is re-executed
 * after the column was already added (Scenario 3 in reconcileJournal).
 *
 * Inspects the full `.cause` chain so a Drizzle-wrapped error (whose real SQLite
 * message lives in `.cause.message`) is still recognised.
 */
export function isDuplicateColumnError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /duplicate column name/i.test(collectErrorMessages(err));
}

/**
 * T9174: Check for "table X already exists" SQLite error.
 * Occurs when migration SQL lacks IF NOT EXISTS but startup DDL already ran.
 *
 * Inspects the full `.cause` chain so a Drizzle-wrapped error (whose real SQLite
 * message lives in `.cause.message`) is still recognised.
 */
export function isTableAlreadyExistsError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /table .+ already exists/i.test(collectErrorMessages(err));
}

/**
 * Check whether a SQL statement is "executable" — i.e., contains something
 * other than whitespace and SQL comments.
 *
 * Used by sanitizeMigrationStatements to filter out both whitespace-only
 * statements (from trailing `--> statement-breakpoint` markers) and comment-only
 * statements (from T1165 probe-and-skip baseline markers).
 *
 * @param stmt - A single SQL statement string
 * @returns false if the statement should be filtered out (no executable DDL)
 */
function isExecutableStatement(stmt: string): boolean {
  // Fast path: empty or whitespace-only.
  if (stmt.trim() === '') return false;
  // Strip SQL line comments (-- ...) and block comments (/* ... */).
  const stripped = stmt
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();
  // If nothing remains after stripping comments, this is a comment-only statement
  // (e.g., a T1165 probe-and-skip baseline marker). Filter it out to prevent
  // drizzle's session.run() from crashing on a comment-only SQL string.
  return stripped !== '';
}

/**
 * Filter whitespace-only and comment-only statements from drizzle's readMigrationFiles output.
 *
 * Guards against two classes of non-executable statements:
 *
 * 1. **Whitespace-only** — caused by trailing `--> statement-breakpoint` markers.
 *    drizzle-orm splits migration files on that marker, producing array entries
 *    that are purely whitespace (e.g., `"\n"`). Passing that to
 *    `session.run(sql.raw("\n"))` causes a "Failed to run the query '\n'" crash.
 *
 * 2. **Comment-only** — the T1165 probe-and-skip baseline marker pattern. A
 *    migration.sql that contains only SQL comments (no executable DDL) is the
 *    designated anchor for drizzle-kit's snapshot chain. On fresh installs the
 *    baseline migration should be a no-op; on existing installs reconcileJournal
 *    Scenario 3 pre-marks it applied before migrate() is called. Either way,
 *    drizzle's session.run() must never receive a comment-only SQL string —
 *    node:sqlite's `prepare()` rejects it with `ERR_INVALID_STATE`.
 *
 * This function is idempotent: migrations with only real DDL pass through unchanged.
 *
 * @param migrations - Array returned by readMigrationFiles
 * @returns A new array where every migration's `.sql` property has been
 *   filtered to remove whitespace-only and comment-only entries.
 */
export function sanitizeMigrationStatements(migrations: MigrationMeta[]): MigrationMeta[] {
  return migrations.map((migration) => ({
    ...migration,
    sql: migration.sql.filter(isExecutableStatement),
  }));
}

/**
 * Minimal interface for drizzle's synchronous SQLite dialect internals.
 *
 * `dialect` and `session` are `@internal` properties on `BaseSQLiteDatabase`
 * — they exist at runtime but are not surfaced in the public TypeScript type.
 * We declare only the subset we need here to avoid coupling to drizzle internals
 * any more than necessary.
 *
 * @internal
 */
interface DrizzleNodeSQLiteInternals {
  dialect: {
    migrate(
      migrations: MigrationMeta[],
      // biome-ignore lint/suspicious/noExplicitAny: session type varies per drizzle version — safe to use any here as we only call .migrate()
      session: any,
      config: MigrationConfig,
    ): void;
  };
  // biome-ignore lint/suspicious/noExplicitAny: session type varies per drizzle version — opaque passthrough
  session: any;
}

/**
 * Run drizzle migrations after sanitizing whitespace-only SQL statements.
 *
 * This is a drop-in replacement for drizzle's `migrate()` from
 * `drizzle-orm/node-sqlite/migrator`. It reads migration files via
 * `readMigrationFiles`, filters any empty/whitespace-only statement chunks,
 * then delegates to `db.dialect.migrate()` directly — bypassing the
 * re-read that drizzle's `migrate()` would perform internally.
 *
 * Use this at every call site instead of drizzle's `migrate()` to defend
 * against malformed migration files regardless of authoring discipline.
 *
 * @param db - Drizzle NodeSQLiteDatabase instance
 * @param config - Migration config (migrationsFolder required)
 */
export function migrateSanitized(
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle's NodeSQLiteDatabase is generic — accepting any schema avoids coupling to a specific schema type
  db: NodeSQLiteDatabase<any>,
  config: MigrationConfig,
): void {
  const raw = readMigrationFiles(config);
  const sanitized = sanitizeMigrationStatements(raw);
  // Access drizzle's @internal dialect and session via a typed assertion.
  // These properties are public at runtime but not surfaced in the TypeScript
  // type declarations (they are documented as @internal in drizzle-orm source).
  const dbInternal = db as unknown as DrizzleNodeSQLiteInternals;
  dbInternal.dialect.migrate(sanitized, dbInternal.session, config);
}

/**
 * Run Drizzle migrations with SQLITE_BUSY retry and exponential backoff.
 *
 * Also handles "duplicate column name" errors (Scenario 3): if Drizzle tries to
 * re-apply a migration whose DDL columns already exist (journal entry missing),
 * this function calls reconcileJournal again to insert the missing entry and
 * retries migrate() once more. This is the belt-and-suspenders safety net for
 * any partial migration that slips through the proactive reconcileJournal check.
 *
 * Uses migrateSanitized internally to filter whitespace-only SQL statements
 * before they reach drizzle's session.run() (T1159 defense-in-depth).
 *
 * @param db - Drizzle database instance
 * @param migrationsFolder - Path to the drizzle migrations folder
 * @param nativeDb - Optional native SQLite handle for duplicate-column auto-reconcile
 * @param existenceTable - Optional existence-check table name for auto-reconcile
 * @param logSubsystem - Optional logger subsystem name for auto-reconcile warnings
 */
export function migrateWithRetry(
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle's NodeSQLiteDatabase is generic — accepting any schema avoids coupling to a specific schema type
  db: NodeSQLiteDatabase<any>,
  migrationsFolder: string,
  nativeDb?: DatabaseSync,
  existenceTable?: string,
  logSubsystem?: string,
): void {
  let duplicateColumnReconciled = false;
  let tableExistsReconciled = false;

  for (let attempt = 1; attempt <= MAX_MIGRATION_RETRIES; attempt++) {
    try {
      migrateSanitized(db, { migrationsFolder });
      return;
    } catch (err) {
      // Belt-and-suspenders: if Drizzle hits a duplicate column name error on
      // the first attempt and we have the native DB handle, run Scenario 3
      // reconcileJournal and retry once. This catches any partial migration that
      // slipped through the proactive check run before migrateWithRetry.
      if (
        isDuplicateColumnError(err) &&
        !duplicateColumnReconciled &&
        nativeDb !== undefined &&
        existenceTable !== undefined &&
        logSubsystem !== undefined
      ) {
        duplicateColumnReconciled = true;
        reconcileJournal(nativeDb, migrationsFolder, existenceTable, logSubsystem);
        continue;
      }

      // T9174: belt-and-suspenders for "table already exists" errors
      if (
        isTableAlreadyExistsError(err) &&
        !tableExistsReconciled &&
        nativeDb !== undefined &&
        existenceTable !== undefined &&
        logSubsystem !== undefined
      ) {
        tableExistsReconciled = true;
        getLogger(logSubsystem).warn(
          { message: (err as Error).message },
          '[T9174] Migration "table already exists" — reconciling journal and retrying',
        );
        reconcileJournal(nativeDb, migrationsFolder, existenceTable, logSubsystem);
        continue;
      }

      if (!isSqliteBusy(err) || attempt === MAX_MIGRATION_RETRIES) {
        throw err;
      }
      const delay = Math.min(
        MIGRATION_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) * (1 + Math.random() * 0.5),
        MIGRATION_RETRY_MAX_DELAY_MS,
      );
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.round(delay));
    }
  }
}

/**
 * Ensure all required columns exist on a table.
 *
 * Uses PRAGMA table_info to inspect the schema and adds any missing columns
 * via ALTER TABLE ADD COLUMN. Safety net for databases where Drizzle migrations
 * could not run due to journal corruption or version skew.
 *
 * The `context` parameter (T9169) categorizes the call site so log levels can
 * reflect intent:
 *
 * - **`'legacy-upgrade'`** (default): the call is a compatibility safety net
 *   for a DB created by an older CLEO version. Missing columns are EXPECTED
 *   and the repair is informational. Logs at WARN level.
 *
 * - **`'fresh'`**: the call follows a successful migration run on a
 *   newly-created DB. Missing columns indicate a migration-chain DEFECT
 *   (missing forward migration or breakpoint truncation). Logs at ERROR
 *   level so the CI schema-warning gate (T9170) can fail the build.
 *
 * @param nativeDb - Native SQLite database handle
 * @param tableName - Table to check (e.g., 'tasks')
 * @param requiredColumns - Columns that must exist
 * @param logSubsystem - Logger subsystem name
 * @param context - 'legacy-upgrade' (default, WARN) or 'fresh' (ERROR)
 */
export function ensureColumns(
  nativeDb: DatabaseSync,
  tableName: string,
  requiredColumns: RequiredColumn[],
  logSubsystem: string,
  context: 'legacy-upgrade' | 'fresh' = 'legacy-upgrade',
): void {
  if (!tableExists(nativeDb, tableName)) return;
  if (requiredColumns.length === 0) return;

  const columns = nativeDb.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name: string;
  }>;
  const existingCols = new Set(columns.map((c) => c.name));

  for (const req of requiredColumns) {
    if (!existingCols.has(req.name)) {
      const log = getLogger(logSubsystem);
      const message = `Adding missing column ${tableName}.${req.name} via ALTER TABLE`;
      const fields = { column: req.name, context };
      if (context === 'fresh') {
        // Migration defect: a fresh DB should NEVER need ensureColumns repair.
        // Surfaced at ERROR so the CI schema-warning budget gate (T9170) fails
        // the build and the gap is closed via an explicit forward migration.
        log.error(fields, `${message} — MIGRATION DEFECT (fresh DB should not need repair)`);
      } else {
        log.warn(fields, message);
      }
      nativeDb.exec(`ALTER TABLE ${tableName} ADD COLUMN ${req.name} ${req.ddl}`);
    }
  }
}
