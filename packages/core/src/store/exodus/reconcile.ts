/**
 * Explicit, verified reconcile of stranded legacy project stores into `cleo.db`.
 *
 * ## Why this exists (T12319)
 *
 * Measured 2026-09-24: ~21 projects ran on an EMPTY consolidated `cleo.db`
 * while their legacy `.cleo/tasks.db` / `.cleo/brain.db` still held everything
 * (llmtxt: 849 tasks + 1,696 observations; claude-todo: 5,330 + 5,148). Two
 * things kept exodus-on-open from ever copying them: a machine-wide
 * `CLEO_DISABLE_EXODUS_ON_OPEN=1` incident kill-switch (skip, silently), and —
 * with the switch off — a copy engine that aborted on real legacy data (FK
 * order, pre-T1408 archive reasons, pre-T877 stages, grandfathered hierarchy
 * rows, NULL `valid_at`). `cleo doctor superseded-store` saw the rows but
 * could only say "reconcile the contents first", with no command to do it.
 *
 * This module is that command's engine. It does NOT write a second copier: the
 * copy is {@link runExodusMigrate} (same transforms, receipts and recovery),
 * restricted to the project target. What it adds is the envelope:
 *
 * - **Assessment by key, not count.** For every legacy table the number of
 *   source rows whose primary key is ABSENT from the live table. A count can
 *   look complete while unrelated rows written into the empty shell mask real
 *   gaps; a key cannot.
 * - **Additive only.** `INSERT OR IGNORE` never overwrites or duplicates a row
 *   already in `cleo.db`; the legacy files are read-only inputs and are never
 *   moved, archived or deleted.
 * - **Verified or reverted.** After the copy the assessment is re-run; any
 *   missing key (or a live table that shrank) reverts exactly the rows this run
 *   inserted, via their receipts, and the outcome is `refused`.
 * - **Idempotent.** A fully reconciled project is a no-op: nothing is written.
 *
 * @module
 * @task T12319
 * @see ./migrate.ts — the single copy engine
 * @see ../../doctor/superseded-store.ts — the survey that points here
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type {
  SupersededStoreConflict,
  SupersededStoreReconcileResult,
  SupersededStoreTableCount,
} from '@cleocode/contracts';
import { getLogger } from '../../logger.js';
import { resolveCleoDir } from '../../paths.js';
import { resolveDualScopeDbPath } from '../dual-scope-db.js';
import { withLock } from '../lock.js';
import { openCleoDbSnapshot } from '../open-cleo-db.js';
import { legacyRowProjection } from './column-transforms.js';
import { runExodusMigrate } from './migrate.js';
import { buildExodusPlan } from './plan.js';
import { rollbackExodusReceipts } from './recovery.js';
import { buildRuntimeTargetResolver, type TargetResolver } from './runtime-targets.js';
import { resolveConsolidatedTableName, resolveTableTargetScope } from './table-name-map.js';
import { orderTablesForCopy } from './table-order.js';
import type { LegacyDbDescriptor } from './types.js';

const log = getLogger('exodus-reconcile');

/** Prefix of a reconcile staging dir — deliberately NOT `exodus-staging-`, which on-open resumes. */
const RECONCILE_DIR_PREFIX = 'exodus-reconcile-' as const;

/** Receipt filename written inside the reconcile staging dir. */
const RECEIPT_FILENAME = 'reconcile-receipt.json' as const;

/** Quote an SQLite identifier. */
function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Whether `schema.table` exists on `db`. */
function hasTable(db: DatabaseSync, schema: string, table: string): boolean {
  return (
    db
      .prepare(`SELECT 1 AS ok FROM ${ident(schema)}.sqlite_master WHERE type='table' AND name=?`)
      .get(table) !== undefined
  );
}

/** Row count of `schema.table`. */
function countRows(db: DatabaseSync, schema: string, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${ident(schema)}.${ident(table)}`).get() as
    | { n: number }
    | undefined;
  return Number(row?.n ?? 0);
}

/**
 * Count rows of the attached legacy table whose primary key is absent from the
 * live table, or `null` when the tables share no complete primary key.
 */
function countMissing(
  live: DatabaseSync,
  alias: string,
  sourceTable: string,
  targetTable: string,
  transformTable: string,
): number | null {
  const targetPk = (
    live.prepare(`PRAGMA main.table_info(${ident(targetTable)})`).all() as Array<{
      name: string;
      pk: number;
    }>
  )
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
  const sourceCols = new Set(
    (
      live.prepare(`PRAGMA ${ident(alias)}.table_info(${ident(sourceTable)})`).all() as Array<{
        name: string;
      }>
    ).map((c) => c.name),
  );
  // A projected key (e.g. release_manifests.id → 'legacy:' || version, T12346)
  // is compared in its PROJECTED form — the form migrate writes.
  const projection = legacyRowProjection(transformTable, sourceTable);
  const sourceKey = (c: string): string | null => {
    const project = projection.get(c);
    if (project) return project((name) => `s.${ident(name)}`);
    return sourceCols.has(c) ? `s.${ident(c)}` : null;
  };
  if (targetPk.length === 0 || !targetPk.every((c) => sourceKey(c) !== null)) return null;
  const match = targetPk.map((c) => `t.${ident(c)} = ${sourceKey(c)}`).join(' AND ');
  const row = live
    .prepare(
      `SELECT COUNT(*) AS n FROM ${ident(alias)}.${ident(sourceTable)} s ` +
        `WHERE NOT EXISTS (SELECT 1 FROM main.${ident(targetTable)} t WHERE ${match})`,
    )
    .get() as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

/**
 * Account for every data-bearing legacy project table against the live store.
 *
 * Read-only on both sides: the live store is opened `readOnly` and each legacy
 * file is ATTACHed to that connection, which SQLite opens read-only too.
 *
 * @param liveStorePath - Absolute path of the live project `cleo.db`.
 * @param sources - Existing project-scope legacy sources.
 * @param resolveTarget - Where each legacy table lands; a reconcile passes the
 *   runtime-read targets ({@link buildRuntimeTargetResolver}).
 * @returns One entry per legacy table holding rows, in copy order.
 * @task T12319
 */
export function assessSupersededProjectStores(
  liveStorePath: string,
  sources: readonly LegacyDbDescriptor[],
  resolveTarget: TargetResolver = resolveConsolidatedTableName,
): SupersededStoreTableCount[] {
  const counts: SupersededStoreTableCount[] = [];
  const live = openCleoDbSnapshot(liveStorePath, { readOnly: true });
  try {
    sources.forEach((src, index) => {
      const alias = `_reconcile_src_${index}`;
      live.db.exec(`ATTACH DATABASE '${src.path.replace(/'/g, "''")}' AS ${ident(alias)}`);
      const snap = openCleoDbSnapshot(src.path, { readOnly: true });
      try {
        for (const sourceTable of orderTablesForCopy(snap.db)) {
          const resolution = resolveTarget(src.name, sourceTable);
          const consolidated = resolveConsolidatedTableName(src.name, sourceTable);
          const transformTable =
            consolidated.kind === 'skip' ? sourceTable : consolidated.targetName;
          if (resolution.kind === 'skip') continue;
          if (resolveTableTargetScope(src.name, sourceTable, 'project') !== 'project') continue;
          const sourceRows = countRows(live.db, alias, sourceTable);
          if (sourceRows === 0) continue;
          const targetTable = resolution.targetName;
          const present = hasTable(live.db, 'main', targetTable);
          counts.push({
            sourceDb: src.name,
            sourceTable,
            targetTable,
            sourceRows,
            liveRows: present ? countRows(live.db, 'main', targetTable) : 0,
            missingInLive: present
              ? countMissing(live.db, alias, sourceTable, targetTable, transformTable)
              : sourceRows,
          });
        }
      } finally {
        snap.close();
        live.db.exec(`DETACH DATABASE ${ident(alias)}`);
      }
    });
  } finally {
    live.close();
  }
  return counts;
}

/**
 * Whether any of `sources` holds at least one row in a table exodus would copy.
 *
 * Cheap by construction — stops at the first non-empty table — because it runs
 * on the open path whenever a consolidated store is empty and its migration is
 * being skipped, to decide whether that skip is stranding real data.
 *
 * @param sources - Legacy source descriptors of ONE scope.
 * @returns `true` when a legacy file still holds copyable rows.
 * @task T12319
 */
export function legacySourcesHoldRows(sources: readonly LegacyDbDescriptor[]): boolean {
  for (const src of sources) {
    if (!existsSync(src.path)) continue;
    const snap = openCleoDbSnapshot(src.path, { readOnly: true });
    try {
      for (const table of orderTablesForCopy(snap.db)) {
        if (resolveConsolidatedTableName(src.name, table).kind === 'skip') continue;
        if (snap.db.prepare(`SELECT 1 AS ok FROM ${ident(table)} LIMIT 1`).get() !== undefined)
          return true;
      }
    } finally {
      snap.close();
    }
  }
  return false;
}

/**
 * Whether a bare legacy table in the live `cleo.db` is one the runtime NO LONGER
 * reads — i.e. its runtime target is a different (prefixed) table. Derived from
 * the runtime's own table bindings via `resolveTarget`, never a hand-kept list:
 * `tasks` → `tasks_tasks` is dead-bare; `audit_log` → `audit_log` is live.
 *
 * @task T12346
 */
function isRuntimeDeadBare(resolveTarget: TargetResolver, table: string): boolean {
  const target = resolveTarget('tasks', table);
  return target.kind !== 'skip' && target.targetName !== table;
}

/** Logical source name for the live store's bare task-core family. */
const BARE_SOURCE_NAME = 'tasks (cleo.db bare task-core)';

/**
 * The live store's own dead bare task-core family as a reconcile source — item
 * 2 of T12319, found real by the T12346 sweep: a stranded `cleo.db` can hold
 * rows in bare tables the runtime no longer reads that exist in NO legacy file
 * (llmtxt: 1,972 `task_labels`; versionguard: 20 `task_dependencies`).
 *
 * Offered ONLY while the prefixed `tasks_tasks` is still empty — i.e. the
 * project never ran on the consolidated store. Once it has, a bare row missing
 * from the prefixed family may be one the runtime deliberately removed, and
 * re-copying it would resurrect it.
 *
 * Materialised as a standalone file in `outDir` holding exactly the qualifying
 * rows, built table by table from the live file's own DDL (a whole-file copy
 * cannot be pruned: sqlite-vec `vec0` tables cannot be dropped without their
 * module). Rows a FRESH project store already holds (e.g. the lineage's 18
 * backfilled `commits`) are not project data and are excluded — measured by
 * building such a store, not by guessing — so a reconciled project ends up
 * with exactly what a fresh one has there, the same as exodus-on-open.
 * The table set is fixed when the file is built, so the post-copy verification
 * judges exactly what was copied.
 *
 * @returns The descriptor (path = the materialised file), or `null`.
 */
async function bareTaskCoreSource(
  liveStorePath: string,
  resolveTarget: TargetResolver,
  outDir: string,
): Promise<LegacyDbDescriptor | null> {
  const live = openCleoDbSnapshot(liveStorePath, { readOnly: true });
  let tables: Array<{ name: string; sql: string }>;
  try {
    if (hasTable(live.db, 'main', 'tasks_tasks') && countRows(live.db, 'main', 'tasks_tasks') > 0)
      return null;
    tables = (
      live.db
        .prepare("SELECT name, sql FROM main.sqlite_master WHERE type='table' AND sql IS NOT NULL")
        .all() as Array<{ name: string; sql: string }>
    ).filter(
      (t) => isRuntimeDeadBare(resolveTarget, t.name) && countRows(live.db, 'main', t.name) > 0,
    );
  } finally {
    live.close();
  }
  if (tables.length === 0) return null;

  const seedPath = await buildFreshProjectStore(join(outDir, 'fresh-project-seed.db'));
  const path = join(outDir, 'cleo-bare-task-core.db');
  const snap = openCleoDbSnapshot(path, { readOnly: false });
  let kept = 0;
  try {
    snap.db.exec('PRAGMA foreign_keys=OFF');
    snap.db.exec(`ATTACH DATABASE '${liveStorePath.replace(/'/g, "''")}' AS live`);
    snap.db.exec(`ATTACH DATABASE '${seedPath.replace(/'/g, "''")}' AS seed`);
    for (const t of tables) {
      snap.db.exec(t.sql);
      snap.db.exec(`INSERT INTO main.${ident(t.name)} SELECT * FROM live.${ident(t.name)}`);
      if (hasTable(snap.db, 'seed', t.name)) {
        const seedCols = new Set(
          (
            snap.db.prepare(`PRAGMA seed.table_info(${ident(t.name)})`).all() as Array<{
              name: string;
            }>
          ).map((c) => c.name),
        );
        const cols = snap.db.prepare(`PRAGMA main.table_info(${ident(t.name)})`).all() as Array<{
          name: string;
          pk: number;
        }>;
        // A seed row is identified by its KEY: seeded rows carry the time they
        // were seeded (e.g. `commits.created_at`), so whole-row equality never
        // matches a seed written on another day. Keyless tables compare rows.
        const pk = cols.filter((c) => c.pk > 0 && seedCols.has(c.name)).map((c) => c.name);
        const match = (pk.length > 0 ? pk : cols.map((c) => c.name).filter((c) => seedCols.has(c)))
          .map((c) => `s.${ident(c)} IS m.${ident(c)}`)
          .join(' AND ');
        if (match.length > 0)
          snap.db.exec(
            `DELETE FROM main.${ident(t.name)} AS m WHERE EXISTS (SELECT 1 FROM seed.${ident(t.name)} s WHERE ${match})`,
          );
      }
      const n = countRows(snap.db, 'main', t.name);
      if (n === 0) snap.db.exec(`DROP TABLE main.${ident(t.name)}`);
      kept += n;
    }
    snap.db.exec('DETACH DATABASE live');
    snap.db.exec('DETACH DATABASE seed');
  } finally {
    snap.close();
  }
  return kept > 0 ? { name: BARE_SOURCE_NAME, path, targetScope: 'project' } : null;
}

/**
 * Build a FRESH project store — consolidated schema plus the tasks-domain
 * lineage, exactly as a brand-new project gets it — and return its path. Its
 * rows are, by construction, only what CLEO seeds (e.g. the 18 backfilled
 * `commits`), never project data.
 */
async function buildFreshProjectStore(path: string): Promise<string> {
  const { getDualScopeNativeDb, openDualScopeDbAtPath } = await import('../dual-scope-db.js');
  const { ensureTasksDomainTables, seedTasksMeta } = await import('../sqlite.js');
  const handle = await openDualScopeDbAtPath('project', path, undefined, { dedicated: true });
  try {
    const native = getDualScopeNativeDb(handle);
    ensureTasksDomainTables(native, path);
    seedTasksMeta(native);
  } finally {
    handle.close();
  }
  return path;
}

/**
 * From the bare task-core snapshot, extract the rows that are strictly NEWER
 * (`updated_at`) than the same-key row in the legacy `tasks.db`, into their own
 * file — copied FIRST so the fresher version of a task wins.
 *
 * Legacy files normally hold the newer copy, but not always: in forge-ts 58 of
 * the 65 tasks that differ were last updated in `cleo.db`'s bare table (7 with
 * a different status). Copy order alone decides which version `INSERT OR
 * IGNORE` keeps, so the freshest rows are given their own, earlier source.
 *
 * @returns The file path, or `null` when no bare row is fresher.
 */
function snapshotFresherBareRows(
  barePath: string,
  legacyTasksPath: string | undefined,
  stagingDir: string,
): string | null {
  if (legacyTasksPath === undefined) return null;
  const path = join(stagingDir, 'cleo-bare-task-core-fresher.db');
  const snap = openCleoDbSnapshot(barePath, { readOnly: true });
  try {
    snap.db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
  } finally {
    snap.close();
  }
  const fresher = openCleoDbSnapshot(path, { readOnly: false });
  let kept = 0;
  try {
    fresher.db.exec('PRAGMA foreign_keys=OFF');
    fresher.db.exec(`ATTACH DATABASE '${legacyTasksPath.replace(/'/g, "''")}' AS legacy`);
    const tables = (
      fresher.db.prepare("SELECT name FROM main.sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((t) => t.name);
    for (const table of tables) {
      const cols = fresher.db.prepare(`PRAGMA main.table_info(${ident(table)})`).all() as Array<{
        name: string;
        pk: number;
      }>;
      const pk = cols.filter((c) => c.pk > 0).map((c) => c.name);
      const inLegacy = hasTable(fresher.db, 'legacy', table);
      const legacyCols = inLegacy
        ? new Set(
            (
              fresher.db.prepare(`PRAGMA legacy.table_info(${ident(table)})`).all() as Array<{
                name: string;
              }>
            ).map((c) => c.name),
          )
        : new Set<string>();
      const comparable =
        inLegacy &&
        pk.length > 0 &&
        cols.some((c) => c.name === 'updated_at') &&
        legacyCols.has('updated_at') &&
        pk.every((k) => legacyCols.has(k));
      if (!comparable) {
        fresher.db.exec(`DELETE FROM main.${ident(table)}`);
        continue;
      }
      const match = pk.map((k) => `l.${ident(k)} = b.${ident(k)}`).join(' AND ');
      fresher.db.exec(
        `DELETE FROM main.${ident(table)} WHERE rowid NOT IN (SELECT b.rowid FROM main.${ident(table)} b ` +
          `JOIN legacy.${ident(table)} l ON ${match} WHERE COALESCE(b.updated_at, '') > COALESCE(l.updated_at, ''))`,
      );
      kept += countRows(fresher.db, 'main', table);
    }
  } finally {
    fresher.close();
  }
  return kept > 0 ? path : null;
}

/** Whether an assessment shows every legacy row present in the live store. */
function isComplete(counts: readonly SupersededStoreTableCount[]): boolean {
  return counts.every((c) =>
    c.missingInLive === null ? c.liveRows >= c.sourceRows : c.missingInLive === 0,
  );
}

/** Tables whose live row count went DOWN between two assessments (never expected). */
function shrunk(
  before: readonly SupersededStoreTableCount[],
  after: readonly SupersededStoreTableCount[],
): string[] {
  return after
    .filter((a) => {
      const b = before.find((x) => x.sourceDb === a.sourceDb && x.sourceTable === a.sourceTable);
      return b !== undefined && a.liveRows < b.liveRows;
    })
    .map((a) => a.targetTable);
}

/** Human-readable list of the tables that still have rows missing. */
function describeGaps(counts: readonly SupersededStoreTableCount[]): string {
  return counts
    .filter((c) => (c.missingInLive === null ? c.liveRows < c.sourceRows : c.missingInLive > 0))
    .map(
      (c) =>
        `${c.targetTable} (${c.missingInLive ?? c.sourceRows - c.liveRows} of ${c.sourceRows} missing)`,
    )
    .join(', ');
}

/** Revert every row this reconcile inserted, proven by its receipts. */
async function revertReconcile(liveStorePath: string, stagingDir: string): Promise<number> {
  const { getDualScopeNativeDb, openDualScopeDbAtPath } = await import('../dual-scope-db.js');
  const handle = await openDualScopeDbAtPath('project', liveStorePath, undefined, {
    dedicated: true,
  });
  try {
    return rollbackExodusReceipts(getDualScopeNativeDb(handle), stagingDir);
  } finally {
    handle.close();
  }
}

/**
 * Whether a legacy table's runtime home belongs to the task graph the project
 * edits live — derived, like every target, from the runtime bindings: a tasks
 * table the runtime re-points at a prefixed twin (`tasks`, `task_dependencies`,
 * `task_acceptance_criteria`, `lifecycle_*`, …). A missing legacy row there may
 * have been deleted or rewritten since the cutover, so an additive run never
 * writes it. History tables the runtime reads under their own name
 * (`audit_log`, `token_usage`, `pipeline_manifest`, …) and brain/conduit rows
 * are append-only and may be filled in.
 */
function isLiveAuthoritative(sourceName: string, legacyTable: string, target: string): boolean {
  return sourceName.toLowerCase().startsWith('tasks') && target !== legacyTable;
}

/** Every legacy row set an assessment shows as still missing, as conflicts. */
function conflictsOf(counts: readonly SupersededStoreTableCount[]): SupersededStoreConflict[] {
  return counts
    .map((c) => ({
      c,
      rows: c.missingInLive ?? Math.max(0, c.sourceRows - c.liveRows),
    }))
    .filter(({ rows }) => rows > 0)
    .map(({ c, rows }) => ({
      sourceDb: c.sourceDb,
      sourceTable: c.sourceTable,
      targetTable: c.targetTable,
      rows,
      reason: isLiveAuthoritative(c.sourceDb, c.sourceTable, c.targetTable)
        ? ('live-authoritative' as const)
        : ('collides-with-live' as const),
    }));
}

/** One line naming every conflict. */
function describeConflicts(conflicts: readonly SupersededStoreConflict[]): string {
  if (conflicts.length === 0) return 'no conflicts';
  return `left ${conflicts.reduce((n, c) => n + c.rows, 0)} row(s) uncopied: ${conflicts
    .map((c) => `${c.targetTable} ${c.rows} (${c.reason})`)
    .join(', ')}`;
}

/** Full-fidelity snapshot of the live store (reads through WAL). */
function snapshotLive(liveStorePath: string, to: string): void {
  const live = openCleoDbSnapshot(liveStorePath, { readOnly: true });
  try {
    live.db.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`);
  } finally {
    live.close();
  }
}

/**
 * Tables among the copy targets in which a row that existed before the copy is
 * no longer present unchanged — compared over the columns both shapes share,
 * so a column a migration ADDS during the run is not an alteration, while a
 * dropped column that held data is. The tasks-domain default `task_id_sequence` is
 * not data (the sequence module treats it as "no state") and is expected to
 * yield to a legacy counter, so `sequenceSeed` rows are exempt.
 */
function alteredLiveTables(
  liveStorePath: string,
  beforePath: string,
  counts: readonly SupersededStoreTableCount[],
  sequenceSeed: string,
): string[] {
  const live = openCleoDbSnapshot(liveStorePath, { readOnly: true });
  try {
    live.db.exec(`ATTACH DATABASE '${beforePath.replace(/'/g, "''")}' AS before`);
    const altered: string[] = [];
    for (const table of new Set(counts.map((c) => c.targetTable))) {
      if (!hasTable(live.db, 'before', table) || !hasTable(live.db, 'main', table)) continue;
      const seed =
        table === 'schema_meta'
          ? ` WHERE NOT (key = 'task_id_sequence' AND value = '${sequenceSeed.replace(/'/g, "''")}')`
          : '';
      // The table's SHAPE may legitimately change during the run: the
      // tasks-domain lineage step can rebuild a bare table with new columns
      // (T12346; claude-todo). Decided deliberately:
      // - a column ADDED by a migration is not an alteration of any
      //   pre-existing row — it did not exist before, so it is not compared;
      // - a column DROPPED is an alteration if it held any value — that data is
      //   no longer in the row — and harmless if it was NULL throughout;
      // - every column both shapes share must still hold every prior row.
      const colsOf = (schema: string): string[] =>
        (
          live.db.prepare(`PRAGMA ${ident(schema)}.table_info(${ident(table)})`).all() as Array<{
            name: string;
          }>
        ).map((c) => c.name);
      const after = new Set(colsOf('main'));
      const beforeCols = colsOf('before');
      const dropped = beforeCols.filter((c) => !after.has(c));
      const droppedWithData = dropped.filter(
        (c) =>
          Number(
            (
              live.db
                .prepare(
                  `SELECT COUNT(*) AS n FROM before.${ident(table)} WHERE ${ident(c)} IS NOT NULL`,
                )
                .get() as { n: number } | undefined
            )?.n ?? 0,
          ) > 0,
      );
      if (droppedWithData.length > 0) {
        altered.push(`${table} (dropped populated column(s): ${droppedWithData.join(', ')})`);
        continue;
      }
      const shared = beforeCols.filter((c) => after.has(c));
      if (shared.length === 0) {
        altered.push(table);
        continue;
      }
      const list = shared.map(ident).join(', ');
      const row = live.db
        .prepare(
          `SELECT COUNT(*) AS n FROM (SELECT ${list} FROM before.${ident(table)}${seed} EXCEPT SELECT ${list} FROM main.${ident(table)})`,
        )
        .get() as { n: number } | undefined;
      if (Number(row?.n ?? 0) > 0) altered.push(table);
    }
    return altered;
  } finally {
    live.close();
  }
}

/**
 * The unmigrated `cleo.db`'s own dead bare task-core family as exodus sources,
 * for exodus-on-open (T12355): the same source the reconcile reads, so the two
 * converge whichever runs first — without it, on-open left e.g. llmtxt's 1,972
 * bare-only `task_labels` behind while a reconcile recovered them.
 *
 * @param liveStorePath - The project `cleo.db` being migrated.
 * @param resolveTarget - The runtime target resolver.
 * @param legacyTasksPath - The legacy `tasks.db`, if present (its fresher-row comparison).
 * @param outDir - Scratch directory the materialised sources are written to.
 * @returns Sources to copy BEFORE the legacy files (bare rows newer than their
 *   legacy copy) and AFTER them (the rest of the bare family); both empty when
 *   the bare family is not a source.
 * @task T12355
 */
export async function unmigratedBareSources(
  liveStorePath: string,
  resolveTarget: TargetResolver,
  legacyTasksPath: string | undefined,
  outDir: string,
): Promise<{ first: LegacyDbDescriptor[]; last: LegacyDbDescriptor[] }> {
  const bare = await bareTaskCoreSource(liveStorePath, resolveTarget, outDir);
  if (bare === null) return { first: [], last: [] };
  const fresher = snapshotFresherBareRows(bare.path, legacyTasksPath, outDir);
  return {
    first:
      fresher === null
        ? []
        : [{ name: `${BARE_SOURCE_NAME} (fresher)`, path: fresher, targetScope: 'project' }],
    last: [bare],
  };
}

/**
 * Reconcile a project's stranded legacy stores into its live `cleo.db`.
 *
 * @param projectRoot - Absolute project root.
 * @param options - `dryRun` assesses and reports without writing anything.
 * @returns The receipt; `outcome: 'refused'` means the copy did not verify and
 *   every row it inserted was reverted.
 * @example
 * ```ts
 * const plan = await reconcileSupersededStores('/mnt/projects/llmtxt', { dryRun: true });
 * for (const t of plan.before) console.log(t.targetTable, t.missingInLive);
 * ```
 * @task T12319
 */
export async function reconcileSupersededStores(
  projectRoot: string,
  options: { readonly dryRun?: boolean; readonly additive?: boolean } = {},
): Promise<SupersededStoreReconcileResult> {
  const liveStorePath = resolveDualScopeDbPath('project', projectRoot);
  // Never let exodus-on-open fire for this store while it is being reconciled
  // (it would archive the legacy files mid-run). Everything — including the
  // plan's source discovery — happens inside the suppression.
  const { withExodusOnOpenSuppressed } = await import('./on-open.js');
  return withExodusOnOpenSuppressed(liveStorePath, () =>
    reconcileSuppressed(projectRoot, options, liveStorePath),
  );
}

/** {@link reconcileSupersededStores} with exodus-on-open suppressed for the store. */
async function reconcileSuppressed(
  projectRoot: string,
  options: { readonly dryRun?: boolean; readonly additive?: boolean },
  liveStorePath: string,
): Promise<SupersededStoreReconcileResult> {
  const dryRun = options.dryRun === true;
  const additive = options.additive === true;
  const plan = buildExodusPlan(projectRoot);
  // Rows land where the RUNTIME reads them (T12346), derived from its bindings.
  const resolveTarget = await buildRuntimeTargetResolver();
  // Scratch space for the materialised bare-family source; outside the project
  // so a dry-run writes nothing there (an apply copies it into its staging dir).
  const scratch = mkdtempSync(join(tmpdir(), 'cleo-reconcile-'));
  try {
    return await reconcileWithScratch(
      projectRoot,
      dryRun,
      additive,
      liveStorePath,
      plan,
      resolveTarget,
      scratch,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The body of {@link reconcileSupersededStores}, with a scratch dir it owns. */
async function reconcileWithScratch(
  projectRoot: string,
  dryRun: boolean,
  additive: boolean,
  liveStorePath: string,
  plan: ReturnType<typeof buildExodusPlan>,
  resolveTarget: TargetResolver,
  scratch: string,
): Promise<SupersededStoreReconcileResult> {
  const fileSources = plan.sources.filter((s) => s.targetScope === 'project' && existsSync(s.path));
  // An additive run is for a project already live on the consolidated store;
  // its bare family is not a source (and bareTaskCoreSource agrees).
  const bare =
    !additive && existsSync(liveStorePath)
      ? await bareTaskCoreSource(liveStorePath, resolveTarget, scratch)
      : null;
  // Additive: the live task graph is never written — only history tables.
  const copyResolver: TargetResolver = additive
    ? (sourceName, legacyTable) => {
        const r = resolveTarget(sourceName, legacyTable);
        return r.kind !== 'skip' && isLiveAuthoritative(sourceName, legacyTable, r.targetName)
          ? { kind: 'skip', reason: 'additive: live-authoritative task graph' }
          : r;
      }
    : resolveTarget;
  // Legacy FILES first so they win any key both hold; the bare family fills gaps.
  const sources = bare ? [...fileSources, bare] : fileSources;
  const base = {
    mode: additive ? ('additive' as const) : ('full' as const),
    conflicts: [] as SupersededStoreConflict[],
    dryRun,
    projectRoot,
    liveStorePath,
    sourcePaths: sources.map((s) => s.path),
    after: [] as SupersededStoreTableCount[],
    rowsCopied: 0,
    rolledBack: 0,
    stagingDir: null,
    receiptPath: null,
  };

  if (sources.length === 0 || !existsSync(liveStorePath)) {
    return {
      ...base,
      outcome: 'nothing-to-reconcile',
      before: [],
      reason:
        sources.length === 0
          ? 'no legacy project store (tasks.db / brain.db / conduit.db, or bare task tables in an unmigrated cleo.db) is present'
          : `no live store at ${liveStorePath}; the legacy files are still the live data`,
    };
  }

  const before = assessSupersededProjectStores(liveStorePath, sources, resolveTarget);
  const plannedConflicts = additive ? conflictsOf(before) : [];
  // Additive: gaps that are ALL live-authoritative leave nothing to copy.
  const onlyConflicts =
    additive &&
    plannedConflicts.length > 0 &&
    plannedConflicts.every((c) => c.reason === 'live-authoritative');
  if (onlyConflicts) {
    return {
      ...base,
      conflicts: plannedConflicts,
      outcome: 'nothing-to-reconcile',
      before,
      reason: `every history row is already present; ${describeConflicts(plannedConflicts)}`,
    };
  }
  if (isComplete(before)) {
    return {
      ...base,
      outcome: 'nothing-to-reconcile',
      before,
      reason: 'every legacy row is already present in cleo.db — nothing to copy',
    };
  }
  if (dryRun) {
    return {
      ...base,
      conflicts: plannedConflicts.filter((c) => c.reason === 'live-authoritative'),
      outcome: 'planned',
      before,
      reason: additive
        ? `would copy the missing rows of the history tables; ${describeConflicts(
            plannedConflicts.filter((c) => c.reason === 'live-authoritative'),
          )} (key collisions are counted after the copy)`
        : `would copy the missing rows of: ${describeGaps(before)}`,
    };
  }

  const iso = new Date()
    .toISOString()
    .replace(/[:]/g, '')
    .replace(/\..+Z$/, 'Z');
  const stagingDir = join(resolveCleoDir(projectRoot), `${RECONCILE_DIR_PREFIX}${iso}`);
  mkdirSync(stagingDir, { recursive: true });
  // Keep the materialised bare source with the run's other evidence.
  const copySources = sources.map((s) => {
    if (s !== bare) return s;
    const kept = join(stagingDir, basename(s.path));
    copyFileSync(s.path, kept);
    return { ...s, path: kept };
  });
  const bareCopy = copySources.find((s) => s.name === BARE_SOURCE_NAME);
  const fresherPath = bareCopy
    ? snapshotFresherBareRows(
        bareCopy.path,
        fileSources.find((s) => s.name === 'tasks')?.path,
        stagingDir,
      )
    : null;
  if (fresherPath !== null)
    copySources.unshift({
      name: `${BARE_SOURCE_NAME} (fresher)`,
      path: fresherPath,
      targetScope: 'project',
    });
  const reconcilePlan = { ...plan, sources: copySources, stagingDir, resumeFromStaging: false };

  // Serialise with exodus-on-open, which takes the same lock on this target.
  const result = await withLock(
    `${liveStorePath}.exodus-on-open.lock`,
    async (): Promise<SupersededStoreReconcileResult> => {
      // Prove "never overwrites": every live row that existed before the copy
      // must still exist, byte for byte, afterwards.
      const liveBefore = join(scratch, 'live-before.db');
      snapshotLive(liveStorePath, liveBefore);
      const migrated = await runExodusMigrate(reconcilePlan, false, (msg) => log.debug(msg), {
        projectOnly: true,
        resolveTarget: copyResolver,
        ensureRuntimeTables: true,
      });
      const rowsCopied = migrated.tables.reduce((n, t) => n + t.rowsCopied, 0);
      const after = migrated.ok
        ? assessSupersededProjectStores(liveStorePath, sources, resolveTarget)
        : [];
      const lost = shrunk(before, after);
      const { TASK_ID_SEQUENCE_SEED } = await import('../sqlite.js');
      let altered: string[] = [];
      if (migrated.ok) {
        try {
          altered = alteredLiveTables(liveStorePath, liveBefore, before, TASK_ID_SEQUENCE_SEED);
        } catch (error) {
          // An unverifiable run is refused and reverted, never reported as done.
          altered = [
            `(verification failed: ${error instanceof Error ? error.message : String(error)})`,
          ];
        }
      }
      const conflicts = additive ? conflictsOf(after) : [];
      const settled = additive ? true : isComplete(after);
      if (migrated.ok && settled && lost.length === 0 && altered.length === 0) {
        return {
          ...base,
          conflicts,
          outcome: 'reconciled',
          before,
          after,
          rowsCopied,
          stagingDir,
          reason: additive
            ? `copied ${rowsCopied} row(s) with keys absent from live; live rows unchanged; ${describeConflicts(conflicts)}`
            : `copied ${rowsCopied} row(s); every legacy row is now present in cleo.db`,
        };
      }
      const rolledBack = await revertReconcile(liveStorePath, stagingDir);
      const cause = !migrated.ok
        ? `copy failed: ${migrated.error ?? `the copy engine gave no message — inspect the journal in ${stagingDir}`}`
        : lost.length > 0
          ? `live tables shrank: ${lost.join(', ')}`
          : altered.length > 0
            ? `pre-existing live rows changed in: ${altered.join(', ')}`
            : `rows still missing after copy: ${describeGaps(after)}`;
      return {
        ...base,
        outcome: 'refused',
        before,
        after,
        rowsCopied,
        rolledBack,
        stagingDir,
        reason: `${cause} — reverted the ${rolledBack} row(s) this run inserted; legacy files untouched`,
      };
    },
    { stale: 600_000, retries: 30 },
  );

  const receiptPath = join(stagingDir, RECEIPT_FILENAME);
  const receipt = { ...result, receiptPath };
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  log.info(
    { outcome: receipt.outcome, rowsCopied: receipt.rowsCopied, receiptPath },
    `exodus-reconcile: ${receipt.reason}`,
  );
  return receipt;
}
