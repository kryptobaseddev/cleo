/**
 * Recover legacy tasks whose id a DIFFERENT live task now holds (T13172).
 *
 * ## Why this exists
 *
 * A deferred exodus-on-open (#1826) left an empty consolidated `cleo.db` while
 * the legacy `tasks.db` still held the project. The user kept working: the
 * empty store allocated `T001` again (strict-spine makes it a saga) while the
 * legacy store also holds a `T001`. The reconcile copies with
 * `INSERT OR IGNORE` and assesses by key, so the legacy `T001` was skipped,
 * counted as present, and its children (`parent_id = 'T001'`) attached to the
 * new saga — while the receipt said every legacy row was present.
 *
 * The fix renumbers before copying, never after: the legacy file is copied into
 * scratch, every colliding legacy task is given a fresh id there, and every
 * reference to it in that copy is re-pointed. The reconcile then assesses and
 * copies from the copy, so the existing engine, its verification and its
 * revert work unchanged, and live rows are never touched.
 *
 * A collision is a legacy task whose id exists live with a different creation
 * instant; a different title alone is the same task renamed since the cutover.
 * When a live task elsewhere already matches the legacy row's title and
 * creation instant (a previous reconcile recovered it), the copy is pointed at
 * that id instead of minting another, so a second run stays a no-op. A
 * recovered task renamed before that second run is not recognised, and would
 * be recovered again.
 *
 * References re-pointed: every column with a declared foreign key to
 * `tasks(id)` (the legacy schema declares them for the hierarchy, dependencies,
 * relations, acceptance criteria and the rest), plus any `task_id` column
 * without one. Task ids embedded in free text or JSON are not rewritten.
 *
 * @module
 * @task T13172
 */

import type { DatabaseSync } from 'node:sqlite';
import type { SupersededStoreIdRemap } from '@cleocode/contracts';
import { openCleoDbSnapshot } from '../open-cleo-db.js';
import { TASK_ID_COLLISIONS_SQL } from './task-id-collision-sql.js';
import type { LegacyDbDescriptor } from './types.js';

/** The legacy table holding task rows, and its consolidated home. */
const LEGACY_TASKS_TABLE = 'tasks' as const;
const LIVE_TASKS_TABLE = 'tasks_tasks' as const;

/** Quote an SQLite identifier. */
function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Quote an SQLite string literal. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Whether `schema.table` exists on `db`. */
function hasTable(db: DatabaseSync, schema: string, table: string): boolean {
  return (
    db
      .prepare(`SELECT 1 AS ok FROM ${ident(schema)}.sqlite_master WHERE type='table' AND name=?`)
      .get(table) !== undefined
  );
}

/** A legacy task whose id a different live task holds. */
interface Collision {
  readonly legacyId: string;
  readonly legacyTitle: string;
  readonly liveTitle: string;
  /** A live task that already matches the legacy row, if a previous run recovered it. */
  readonly recoveredAs: string | null;
}

/** Text value of a row column, or `''`. */
function text(row: Record<string, unknown> | undefined, key: string): string {
  const value = row?.[key];
  return typeof value === 'string' ? value : '';
}

/** Legacy tasks whose id a different live task holds ({@link TASK_ID_COLLISIONS_SQL}). */
function findCollisions(liveStorePath: string, legacyPath: string): Collision[] {
  const live = openCleoDbSnapshot(liveStorePath, { readOnly: true });
  try {
    live.db.exec(`ATTACH DATABASE ${literal(legacyPath)} AS legacy`);
    try {
      if (
        !hasTable(live.db, 'legacy', LEGACY_TASKS_TABLE) ||
        !hasTable(live.db, 'main', LIVE_TASKS_TABLE)
      ) {
        return [];
      }
      const rows = live.db.prepare(TASK_ID_COLLISIONS_SQL).all() as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        legacyId: text(row, 'legacyId'),
        legacyTitle: text(row, 'legacyTitle'),
        liveTitle: text(row, 'liveTitle'),
        recoveredAs: text(row, 'recoveredAs') || null,
      }));
    } finally {
      live.db.exec('DETACH DATABASE legacy');
    }
  } finally {
    live.close();
  }
}

/** Highest numeric `T<n>` id among `ids`, or 0. */
function maxNumericId(ids: readonly string[]): number {
  let max = 0;
  for (const id of ids) {
    const match = /^T(\d+)$/.exec(id);
    if (match?.[1] !== undefined) max = Math.max(max, Number(match[1]));
  }
  return max;
}

/** Every task id in `schema.table` of `db`. */
function idsOf(db: DatabaseSync, schema: string, table: string): string[] {
  if (!hasTable(db, schema, table)) return [];
  return (
    db.prepare(`SELECT id FROM ${ident(schema)}.${ident(table)}`).all() as Array<
      Record<string, unknown>
    >
  ).map((row) => text(row, 'id'));
}

/** Columns of `db` that hold a task id: declared foreign keys to `tasks(id)`, and `task_id`. */
function taskIdColumns(db: DatabaseSync): Array<{ table: string; column: string }> {
  const tables = (
    db
      .prepare(
        "SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as Array<Record<string, unknown>>
  ).map((row) => text(row, 'name'));
  const columns: Array<{ table: string; column: string }> = [];
  for (const table of tables) {
    const seen = new Set<string>();
    const fks = db.prepare(`PRAGMA main.foreign_key_list(${ident(table)})`).all() as Array<
      Record<string, unknown>
    >;
    for (const fk of fks) {
      const to = text(fk, 'to');
      if (text(fk, 'table') === LEGACY_TASKS_TABLE && (to === 'id' || to === '')) {
        seen.add(text(fk, 'from'));
      }
    }
    const cols = db.prepare(`PRAGMA main.table_info(${ident(table)})`).all() as Array<
      Record<string, unknown>
    >;
    for (const col of cols) {
      const name = text(col, 'name');
      if (name === 'task_id' || (table === LEGACY_TASKS_TABLE && name === 'id')) seen.add(name);
    }
    for (const column of seen) columns.push({ table, column });
  }
  return columns;
}

/** Result of {@link remapCollidingTaskIds}. */
export interface TaskIdRemapResult {
  /** The sources to assess and copy: the legacy tasks source replaced by its renumbered copy. */
  readonly sources: LegacyDbDescriptor[];
  /** One entry per renumbered legacy task; empty when nothing collides. */
  readonly remaps: SupersededStoreIdRemap[];
  /** Path of the renumbered copy, or `null` when no copy was needed. */
  readonly remappedPath: string | null;
}

/**
 * Renumber legacy tasks whose id a different live task holds, in a scratch
 * copy of the legacy `tasks.db`, and return the sources to reconcile from.
 *
 * @param liveStorePath - The live project `cleo.db` (read only).
 * @param sources - The project's legacy sources.
 * @param scratch - Directory the renumbered copy is written to.
 * @returns The sources (unchanged when nothing collides) and the remaps.
 * @example
 * ```ts
 * const { sources, remaps } = remapCollidingTaskIds(livePath, fileSources, scratch);
 * for (const r of remaps) console.log(`${r.legacyId} -> ${r.newId}`);
 * ```
 */
export function remapCollidingTaskIds(
  liveStorePath: string,
  sources: readonly LegacyDbDescriptor[],
  scratch: string,
): TaskIdRemapResult {
  const tasksSource = sources.find((s) => s.name === 'tasks');
  if (tasksSource === undefined) return { sources: [...sources], remaps: [], remappedPath: null };
  const collisions = findCollisions(liveStorePath, tasksSource.path);
  if (collisions.length === 0) return { sources: [...sources], remaps: [], remappedPath: null };

  const remappedPath = `${scratch}/tasks.remapped.db`;
  const legacy = openCleoDbSnapshot(tasksSource.path, { readOnly: true });
  let legacyIds: string[];
  try {
    // VACUUM INTO folds any WAL content into the copy; the legacy file is untouched.
    legacy.db.exec(`VACUUM INTO ${literal(remappedPath)}`);
    legacyIds = idsOf(legacy.db, 'main', LEGACY_TASKS_TABLE);
  } finally {
    legacy.close();
  }
  const liveIds = (() => {
    const live = openCleoDbSnapshot(liveStorePath, { readOnly: true });
    try {
      return idsOf(live.db, 'main', LIVE_TASKS_TABLE);
    } finally {
      live.close();
    }
  })();

  let next = maxNumericId([...liveIds, ...legacyIds]);
  const remaps: SupersededStoreIdRemap[] = collisions.map((c) => ({
    sourceDb: tasksSource.name,
    legacyId: c.legacyId,
    newId: c.recoveredAs ?? `T${String(++next).padStart(3, '0')}`,
    legacyTitle: c.legacyTitle,
    liveTitle: c.liveTitle,
    alreadyRecovered: c.recoveredAs !== null,
    referencesRepointed: 0,
  }));

  const copy = openCleoDbSnapshot(remappedPath, { readOnly: false, applyPragmas: false });
  try {
    copy.db.exec('PRAGMA foreign_keys = OFF');
    const columns = taskIdColumns(copy.db);
    // Two passes through placeholders, so a new id that equals another
    // collision's legacy id can never be renumbered twice.
    copy.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [index, remap] of remaps.entries()) {
        const placeholder = `__cleo_task_remap_${index}__`;
        for (const { table, column } of columns) {
          const changed = copy.db
            .prepare(`UPDATE ${ident(table)} SET ${ident(column)} = ? WHERE ${ident(column)} = ?`)
            .run(placeholder, remap.legacyId).changes;
          if (!(table === LEGACY_TASKS_TABLE && column === 'id')) {
            remap.referencesRepointed += Number(changed);
          }
        }
      }
      for (const [index, remap] of remaps.entries()) {
        const placeholder = `__cleo_task_remap_${index}__`;
        for (const { table, column } of columns) {
          copy.db
            .prepare(`UPDATE ${ident(table)} SET ${ident(column)} = ? WHERE ${ident(column)} = ?`)
            .run(remap.newId, placeholder);
        }
      }
      copy.db.exec('COMMIT');
    } catch (error) {
      copy.db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    copy.close();
  }

  return {
    sources: sources.map((s) => (s === tasksSource ? { ...s, path: remappedPath } : s)),
    remaps,
    remappedPath,
  };
}

/**
 * One line naming every remap, for a receipt's reason.
 *
 * @param remaps - The remaps of a run.
 * @returns E.g. `legacy T001 ("old saga") -> T004 (live T001 is "new saga")`.
 * @example
 * ```ts
 * describeRemaps(remaps); // 'recovered 1 legacy task under a new id: ...'
 * ```
 */
export function describeRemaps(remaps: readonly SupersededStoreIdRemap[]): string {
  const items = remaps.map(
    (r) =>
      `legacy ${r.legacyId} ("${r.legacyTitle}") -> ${r.newId}` +
      `${r.alreadyRecovered ? ' (already recovered)' : ''}, because live ${r.legacyId} is "${r.liveTitle}"`,
  );
  return `${remaps.length} legacy task(s) whose id a different live task holds, recovered under new ids: ${items.join('; ')}`;
}
