/**
 * The live store's own bare legacy family as a reconcile source.
 *
 * A `cleo.db` from before consolidation can hold rows in bare tables
 * (`tasks`, `task_labels`, `sessions`, …) that the runtime no longer reads.
 * Two reconcile modes carry them into the prefixed tables:
 *
 * - full mode, while `tasks_tasks` is still EMPTY (the project never ran on
 *   the consolidated store): every bare row (T12346);
 * - bare-strands mode (T13309), once `tasks_tasks` is populated: only bare
 *   rows whose key the prefixed twin lacks, plus bare tasks whose id a
 *   DIFFERENT live task took (renumbered by the caller). A row that is, or
 *   refers to, a task the live store recorded as deleted is skipped and named,
 *   never resurrected, and so is a row referring to a task neither side holds.
 *
 * @module
 * @task T12346
 * @task T13309
 */

import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { SupersededStoreBareAccount, SupersededStoreConflict } from '@cleocode/contracts';
import { openCleoDbSnapshot } from '../open-cleo-db.js';
import { bareTableDigest } from '../sync/flags.js';
import { taskReferenceColumns } from '../task-reference-columns.js';
import { legacyRowProjection } from './column-transforms.js';
import { loadPriorRecoveries, priorRecoveries } from './prior-recoveries.js';
import type { TargetResolver } from './runtime-targets.js';
import { resolveConsolidatedTableName } from './table-name-map.js';
import { countRows, hasTable, ident } from './table-order.js';
import { taskIdCollisionsSql } from './task-id-collision-sql.js';
import { BARE_SOURCE_NAME, BARE_STRANDS_SOURCE_NAME, type LegacyDbDescriptor } from './types.js';

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

/** The dead bare tables of the live store that hold rows, with their DDL. */
function deadBareTables(
  live: DatabaseSync,
  resolveTarget: TargetResolver,
): Array<{ name: string; sql: string }> {
  return (
    live
      .prepare("SELECT name, sql FROM main.sqlite_master WHERE type='table' AND sql IS NOT NULL")
      .all() as Array<{ name: string; sql: string }>
  ).filter((t) => isRuntimeDeadBare(resolveTarget, t.name) && countRows(live, 'main', t.name) > 0);
}

/** Whether `tasks_tasks` holds a row (the project has run on the consolidated store). */
function liveTaskGraphPopulated(live: DatabaseSync): boolean {
  return hasTable(live, 'main', 'tasks_tasks') && countRows(live, 'main', 'tasks_tasks') > 0;
}

/**
 * The live store's own dead bare task-core family as a reconcile source — item
 * 2 of T12319, found real by the T12346 sweep: a stranded `cleo.db` can hold
 * rows in bare tables the runtime no longer reads that exist in NO legacy file
 * (llmtxt: 1,972 `task_labels`; versionguard: 20 `task_dependencies`).
 *
 * Offered ONLY while the prefixed `tasks_tasks` is still empty — i.e. the
 * project never ran on the consolidated store. Once it has, a bare row missing
 * from the prefixed family may be one the runtime deliberately removed; the
 * bare-strands mode ({@link bareStrandSource}) handles that case.
 *
 * @returns The descriptor (path = the materialised file), or `null`.
 */
export async function bareTaskCoreSource(
  liveStorePath: string,
  resolveTarget: TargetResolver,
  outDir: string,
): Promise<LegacyDbDescriptor | null> {
  const live = openCleoDbSnapshot(liveStorePath, { readOnly: true });
  let tables: Array<{ name: string; sql: string }>;
  try {
    if (liveTaskGraphPopulated(live.db)) return null;
    tables = deadBareTables(live.db, resolveTarget);
  } finally {
    live.close();
  }
  if (tables.length === 0) return null;
  const path = join(outDir, 'cleo-bare-task-core.db');
  const kept = await materializeBareTables(liveStorePath, tables, path, outDir);
  return kept > 0 ? { name: BARE_SOURCE_NAME, path, targetScope: 'project' } : null;
}

/**
 * Copy `tables` (rows and DDL) out of the live store into a standalone file at
 * `path`, minus rows a FRESH project store already holds.
 *
 * Built table by table from the live file's own DDL (a whole-file copy cannot
 * be pruned: sqlite-vec `vec0` tables cannot be dropped without their module).
 * Rows a fresh project store already holds (e.g. the lineage's 18 backfilled
 * `commits`) are not project data and are excluded — measured by building such
 * a store, not by guessing — so a reconciled project ends up with exactly what
 * a fresh one has there, the same as exodus-on-open. Tables left empty are
 * dropped, so the post-copy verification judges exactly what was copied.
 *
 * @returns The rows kept.
 */
async function materializeBareTables(
  liveStorePath: string,
  tables: ReadonlyArray<{ name: string; sql: string }>,
  path: string,
  outDir: string,
): Promise<number> {
  const seedPath = await buildFreshProjectStore(join(outDir, 'fresh-project-seed.db'));
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
  return kept;
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

/** Result of {@link bareStrandSource}. */
export interface BareStrandSource {
  /** The materialised stranded rows, or `null` when none is left to copy. */
  readonly source: LegacyDbDescriptor | null;
  /** Rows deliberately left uncopied, per table and reason. */
  readonly skipped: SupersededStoreConflict[];
  /** Every bare table with rows, as the run found it (recorded on success). */
  readonly accounted: SupersededStoreBareAccount[];
  /** `false` when the live task graph is empty: full mode's case, not this one. */
  readonly populated: boolean;
}

/** One SQL key expression per column of the twin's primary key, or `null`. */
function keyMatch(
  db: DatabaseSync,
  bareSchema: string,
  bare: string,
  twinSchema: string,
  twin: string,
): string | null {
  const pk = (
    db.prepare(`PRAGMA ${ident(twinSchema)}.table_info(${ident(twin)})`).all() as Array<{
      name: string;
      pk: number;
    }>
  )
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
  const bareCols = new Set(
    (
      db.prepare(`PRAGMA ${ident(bareSchema)}.table_info(${ident(bare)})`).all() as Array<{
        name: string;
      }>
    ).map((c) => c.name),
  );
  // Compared in the PROJECTED form the copy writes (T12346), as countMissing does.
  const projection = legacyRowProjection(twin, bare);
  const keyOf = (c: string): string | null => {
    const project = projection.get(c);
    if (project) return project((name) => `s.${ident(name)}`);
    return bareCols.has(c) ? `s.${ident(c)}` : null;
  };
  if (pk.length === 0 || !pk.every((c) => keyOf(c) !== null)) return null;
  return pk.map((c) => `t.${ident(c)} = ${keyOf(c)}`).join(' AND ');
}

/**
 * The live store's stranded bare rows as a reconcile source (T13309): for a
 * project already running on the consolidated store, the bare rows whose key
 * the prefixed twin lacks, and the bare tasks a different live task shadows by
 * id (kept so the caller's renumbering recovers them).
 *
 * Skipped, and named in `skipped`: a row that is, or whose task reference
 * points at, a task the live store recorded as deleted (`tasks_audit_log`
 * action `task_deleted`), and a row whose task reference neither the live
 * store nor the copy holds. A deletion record of a shadowed id belongs to the
 * live task holding it and skips nothing. A table whose twin key the bare
 * table cannot produce keeps every row, and the post-copy verification judges
 * it.
 *
 * @param liveStorePath - The live project `cleo.db` (read only).
 * @param resolveTarget - Runtime target resolver.
 * @param outDir - Scratch directory for the materialised file.
 * @param cleoDir - The project's `.cleo`, where earlier receipts live.
 */
export async function bareStrandSource(
  liveStorePath: string,
  resolveTarget: TargetResolver,
  outDir: string,
  cleoDir: string,
): Promise<BareStrandSource> {
  const live = openCleoDbSnapshot(liveStorePath, { readOnly: true });
  let tables: Array<{ name: string; sql: string }>;
  let shadowed: string[] = [];
  let deleted: string[] = [];
  let accounted: SupersededStoreBareAccount[];
  try {
    if (!liveTaskGraphPopulated(live.db)) {
      return { source: null, skipped: [], accounted: [], populated: false };
    }
    tables = deadBareTables(live.db, resolveTarget);
    accounted = tables.map((t) => bareTableDigest(live.db, 'main', t.name));
    if (tables.some((t) => t.name === 'tasks')) shadowed = shadowedBareTaskIds(live.db, cleoDir);
    if (hasTable(live.db, 'main', 'tasks_audit_log')) {
      deleted = (
        live.db
          .prepare(
            "SELECT DISTINCT task_id AS id FROM main.tasks_audit_log WHERE action = 'task_deleted'",
          )
          .all() as Array<{ id: string }>
      ).map((r) => r.id);
    }
  } finally {
    live.close();
  }
  if (tables.length === 0) return { source: null, skipped: [], accounted, populated: true };

  const path = join(outDir, 'cleo-bare-strands.db');
  await materializeBareTables(liveStorePath, tables, path, outDir);
  const skipped: SupersededStoreConflict[] = [];
  const snap = openCleoDbSnapshot(path, { readOnly: false, applyPragmas: false });
  let kept = 0;
  try {
    const db = snap.db;
    db.exec('PRAGMA foreign_keys=OFF');
    db.exec(`ATTACH DATABASE '${liveStorePath.replace(/'/g, "''")}' AS live`);
    db.exec('CREATE TEMP TABLE strand_shadowed (id TEXT PRIMARY KEY)');
    db.exec('CREATE TEMP TABLE strand_deleted (id TEXT PRIMARY KEY)');
    const addShadowed = db.prepare('INSERT OR IGNORE INTO temp.strand_shadowed VALUES (?)');
    for (const id of shadowed) addShadowed.run(id);
    const addDeleted = db.prepare('INSERT OR IGNORE INTO temp.strand_deleted VALUES (?)');
    for (const id of deleted) addDeleted.run(id);
    // A shadowed id's deletion record is the LIVE holder's, a different task.
    db.exec('DELETE FROM temp.strand_deleted WHERE id IN (SELECT id FROM temp.strand_shadowed)');
    const present = (): string[] =>
      tables.map((t) => t.name).filter((name) => hasTable(db, 'main', name));
    const twinOf = (bare: string): string => {
      const r = resolveTarget('tasks', bare);
      return r.kind === 'skip' ? bare : r.targetName;
    };

    // 1. Rows the twin already holds by key are not stranded (a shadowed task
    //    is kept for the caller's renumbering).
    for (const bare of present()) {
      const twin = twinOf(bare);
      if (!hasTable(db, 'live', twin)) continue;
      const match = keyMatch(db, 'main', bare, 'live', twin);
      if (match === null) continue;
      const keep = bare === 'tasks' ? ' AND s.id NOT IN (SELECT id FROM temp.strand_shadowed)' : '';
      db.exec(
        `DELETE FROM main.${ident(bare)} AS s WHERE EXISTS (SELECT 1 FROM live.${ident(twin)} t WHERE ${match})${keep}`,
      );
    }

    // 2. A deleted task, or a row referring to one, would be resurrected.
    const localName = localNameOf(db);
    const refs = taskReferenceColumns(db, localName).filter((r) => !r.jsonArray);
    const drop = (
      table: string,
      column: string,
      where: string,
      reason: SupersededStoreConflict['reason'],
    ): void => {
      const ids = (
        db
          .prepare(
            `SELECT DISTINCT ${ident(column)} AS id FROM main.${ident(table)} WHERE ${where} ORDER BY 1`,
          )
          .all() as Array<{ id: string }>
      ).map((r) => String(r.id));
      if (ids.length === 0) return;
      const rows = db.prepare(`DELETE FROM main.${ident(table)} WHERE ${where}`).run().changes;
      skipped.push({
        sourceDb: BARE_STRANDS_SOURCE_NAME,
        sourceTable: table,
        targetTable: twinOf(table),
        rows: Number(rows),
        reason,
        ids,
      });
    };
    if (hasTable(db, 'main', 'tasks')) {
      drop('tasks', 'id', 'id IN (SELECT id FROM temp.strand_deleted)', 'deleted-live');
    }
    for (const ref of refs) {
      if (!hasTable(db, 'main', ref.table)) continue;
      drop(
        ref.table,
        ref.column,
        `${ident(ref.column)} IN (SELECT id FROM temp.strand_deleted)`,
        'deleted-live',
      );
    }

    // 3. A reference to a task neither side holds would dangle.
    const copiesTasks = hasTable(db, 'main', 'tasks');
    for (const ref of refs) {
      if (!hasTable(db, 'main', ref.table)) continue;
      const c = ident(ref.column);
      const inCopy = copiesTasks ? ` AND ${c} NOT IN (SELECT id FROM main.tasks)` : '';
      drop(
        ref.table,
        ref.column,
        `${c} IS NOT NULL AND ${c} NOT IN (SELECT id FROM live.tasks_tasks)${inCopy}`,
        'parent-absent',
      );
    }

    for (const bare of present()) {
      const n = countRows(db, 'main', bare);
      if (n === 0) db.exec(`DROP TABLE main.${ident(bare)}`);
      kept += n;
    }
    db.exec('DETACH DATABASE live');
  } finally {
    snap.close();
  }
  return {
    source: kept > 0 ? { name: BARE_STRANDS_SOURCE_NAME, path, targetScope: 'project' } : null,
    skipped,
    accounted,
    populated: true,
  };
}

/**
 * Bare `tasks` ids a DIFFERENT live task holds (the T001 reuse case), by the
 * reconcile's one collision definition. One an earlier run already recovered
 * is included too: the caller's renumbering maps it to the recovered task, so
 * its children re-point there instead of onto the live task holding the id.
 */
function shadowedBareTaskIds(live: DatabaseSync, cleoDir: string): string[] {
  const has = (table: string, cols: readonly string[]): boolean => {
    const names = new Set(
      (
        live.prepare(`PRAGMA main.table_info(${ident(table)})`).all() as Array<{ name: string }>
      ).map((c) => c.name),
    );
    return cols.every((c) => names.has(c));
  };
  const cols = ['id', 'title', 'created_at', 'type'] as const;
  if (!has('tasks', cols) || !has('tasks_tasks', cols)) return [];
  loadPriorRecoveries(live, priorRecoveries(cleoDir));
  return (
    live.prepare(`SELECT legacyId FROM (${taskIdCollisionsSql('main.tasks')})`).all() as Array<{
      legacyId: string;
    }>
  ).map((r) => r.legacyId);
}

/** Consolidated table name → its name in a bare-family file, by the exodus map. */
function localNameOf(db: DatabaseSync): (consolidated: string) => string | null {
  const byConsolidated = new Map<string, string>();
  const tables = db
    .prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  for (const { name } of tables) {
    const r = resolveConsolidatedTableName('tasks', name);
    if (r.kind !== 'skip') byConsolidated.set(r.targetName, name);
  }
  return (consolidated) => byConsolidated.get(consolidated) ?? null;
}
