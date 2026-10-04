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
 * scratch, every colliding legacy task gets a fresh id there, and everything
 * that refers to it in that copy follows, exactly as a display-id rename does
 * in `cleo.db`:
 *
 * - every column that holds a task id ({@link taskReferenceColumns}: declared
 *   foreign keys plus the ROW_IDENTITY refs, key refs, owners and JSON-array
 *   refs such as a session's `tasks_completed_json`), mapped to the legacy
 *   table names;
 * - the acceptance criteria whose ids are derived from the task id
 *   (`buildAcRowId`) are re-derived, with their evidence bindings and history
 *   ({@link rederiveAcIdsNative}). Without that the recovered task's
 *   "tests pass" criterion has the same id as the live `T001`'s and is
 *   skipped by `INSERT OR IGNORE`.
 *
 * The reconcile then assesses and copies from the copy, so the copy engine,
 * its verification and its revert work unchanged, and live rows are never
 * touched. What a collision is, and when a legacy task was already recovered
 * by an earlier run, is decided by {@link TASK_ID_COLLISIONS_SQL}. A collision
 * whose creation times cannot be compared is reported, never renumbered.
 *
 * Not rewritten: task ids inside free text (titles, descriptions, notes).
 *
 * @module
 * @task T13172
 */

import type { DatabaseSync } from 'node:sqlite';
import type { SupersededStoreConflict, SupersededStoreIdRemap } from '@cleocode/contracts';
import { openCleoDbSnapshot } from '../open-cleo-db.js';
import { rederiveAcIdsNative, rewriteTaskIdReferencesNative } from '../sqlite-data-accessor.js';
import { taskReferenceColumns } from '../task-reference-columns.js';
import { resolveConsolidatedTableName } from './table-name-map.js';
import { TASK_ID_COLLISIONS_SQL } from './task-id-collision-sql.js';
import type { LegacyDbDescriptor } from './types.js';

/** The legacy table holding task rows, and its consolidated home. */
const LEGACY_TASKS_TABLE = 'tasks' as const;
const LIVE_TASKS_TABLE = 'tasks_tasks' as const;

/** The note every receipt with remaps carries about what is not rewritten. */
export const FREE_TEXT_IDS_NOTE =
  'task ids written inside free text (titles, descriptions, notes) are not rewritten';

/** Quote an SQLite string literal. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Whether `schema.table` exists on `db`. */
function hasTable(db: DatabaseSync, schema: string, table: string): boolean {
  return (
    db
      .prepare(`SELECT 1 AS ok FROM "${schema}".sqlite_master WHERE type='table' AND name=?`)
      .get(table) !== undefined
  );
}

/** Text value of a row column, or `''`. */
function text(row: Record<string, unknown> | undefined, key: string): string {
  const value = row?.[key];
  return typeof value === 'string' ? value : '';
}

/** One row of {@link TASK_ID_COLLISIONS_SQL}. */
interface Collision {
  readonly legacyId: string;
  readonly legacyTitle: string;
  readonly legacyCreatedAt: string;
  readonly liveTitle: string;
  readonly decision: 'collision' | 'undecided';
  readonly recoveredAs: string | null;
}

/** Collisions between the legacy tasks at `legacyPath` and the live store. */
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
        legacyCreatedAt: text(row, 'legacyCreatedAt'),
        liveTitle: text(row, 'liveTitle'),
        decision: text(row, 'decision') === 'undecided' ? 'undecided' : 'collision',
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
    db.prepare(`SELECT id FROM "${schema}"."${table}"`).all() as Array<Record<string, unknown>>
  ).map((row) => text(row, 'id'));
}

/**
 * Consolidated table name → its name in a legacy `tasks.db` copy, from the
 * tables the copy holds and the exodus table-name map.
 */
function legacyNameMap(db: DatabaseSync): (consolidated: string) => string | null {
  const byConsolidated = new Map<string, string>();
  const tables = db
    .prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<Record<string, unknown>>;
  for (const row of tables) {
    const legacy = text(row, 'name');
    const resolution = resolveConsolidatedTableName('tasks', legacy);
    if (resolution.kind !== 'skip') byConsolidated.set(resolution.targetName, legacy);
  }
  return (consolidated) => byConsolidated.get(consolidated) ?? null;
}

/** A remap plus what the post-copy check needs to prove the new id is ours. */
export interface PlannedRemap extends SupersededStoreIdRemap {
  /** The legacy row's creation time, compared with the copied row after the copy. */
  readonly legacyCreatedAt: string;
}

/** Result of {@link remapCollidingTaskIds}. */
export interface TaskIdRemapResult {
  /** The sources to assess and copy: the legacy tasks source replaced by its renumbered copy. */
  readonly sources: LegacyDbDescriptor[];
  /** One entry per renumbered legacy task; empty when nothing collides. */
  readonly remaps: PlannedRemap[];
  /** Collisions the run cannot decide (unparseable creation time), as one conflict, or `null`. */
  readonly undecided: SupersededStoreConflict | null;
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
 * @returns The sources (unchanged when nothing needs renumbering), the
 *   remaps, and any collision the run cannot decide.
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
  const unchanged = { sources: [...sources], remaps: [], undecided: null, remappedPath: null };
  const tasksSource = sources.find((s) => s.name === 'tasks');
  if (tasksSource === undefined) return unchanged;
  const collisions = findCollisions(liveStorePath, tasksSource.path);
  const undecidedIds = collisions.filter((c) => c.decision === 'undecided').map((c) => c.legacyId);
  const undecided: SupersededStoreConflict | null =
    undecidedIds.length === 0
      ? null
      : {
          sourceDb: tasksSource.name,
          sourceTable: LEGACY_TASKS_TABLE,
          targetTable: LIVE_TASKS_TABLE,
          rows: undecidedIds.length,
          reason: 'id-collision-undecided',
          ids: undecidedIds,
        };
  const decided = collisions.filter((c) => c.decision === 'collision');
  if (decided.length === 0) return { ...unchanged, undecided };

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

  // Fresh ids are above every id either store holds, so a new id is never
  // another task's legacy id and the renumbering needs no ordering.
  let next = maxNumericId([...liveIds, ...legacyIds]);
  const remaps: PlannedRemap[] = decided.map((c) => ({
    sourceDb: tasksSource.name,
    legacyId: c.legacyId,
    newId: c.recoveredAs ?? `T${String(++next).padStart(3, '0')}`,
    legacyTitle: c.legacyTitle,
    liveTitle: c.liveTitle,
    alreadyRecovered: c.recoveredAs !== null,
    referencesRepointed: 0,
    legacyCreatedAt: c.legacyCreatedAt,
  }));

  const copy = openCleoDbSnapshot(remappedPath, { readOnly: false, applyPragmas: false });
  try {
    copy.db.exec('PRAGMA foreign_keys = OFF');
    const localName = legacyNameMap(copy.db);
    const refs = taskReferenceColumns(copy.db, localName);
    const acTables = {
      criteria: localName('tasks_task_acceptance_criteria') ?? 'task_acceptance_criteria',
      followers: ['tasks_evidence_ac_bindings', 'tasks_task_acceptance_criteria_history']
        .map(localName)
        .filter((name): name is string => name !== null),
    };
    copy.db.exec('BEGIN IMMEDIATE');
    try {
      for (const remap of remaps) {
        copy.db
          .prepare(`UPDATE "${LEGACY_TASKS_TABLE}" SET id = ? WHERE id = ?`)
          .run(remap.newId, remap.legacyId);
        const rewritten = {
          ...rewriteTaskIdReferencesNative(copy.db, refs, remap.legacyId, remap.newId),
        };
        for (const [key, n] of Object.entries(
          rederiveAcIdsNative(copy.db, remap.legacyId, remap.newId, acTables),
        )) {
          rewritten[key] = (rewritten[key] ?? 0) + n;
        }
        remap.referencesRepointed = Object.values(rewritten).reduce((a, b) => a + b, 0);
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
    undecided,
    remappedPath,
  };
}

/**
 * Remaps whose new id the live store does not hold as the recovered legacy
 * task after the copy: a concurrent write took the id first, so the copy's
 * `INSERT OR IGNORE` skipped the recovered task. Empty when every remap landed.
 *
 * @param liveStorePath - The live project `cleo.db`.
 * @param remaps - The run's remaps.
 * @returns `legacyId -> newId` for each remap that did not land.
 * @example
 * ```ts
 * if (unlandedRemaps(live, remaps).length > 0) revert();
 * ```
 */
export function unlandedRemaps(liveStorePath: string, remaps: readonly PlannedRemap[]): string[] {
  if (remaps.length === 0) return [];
  const live = openCleoDbSnapshot(liveStorePath, { readOnly: true });
  try {
    const row = live.db.prepare(
      `SELECT 1 AS ok FROM ${LIVE_TASKS_TABLE}
        WHERE id = ? AND title IS ? AND julianday(created_at) IS julianday(?)`,
    );
    return remaps
      .filter((r) => row.get(r.newId, r.legacyTitle, r.legacyCreatedAt) === undefined)
      .map((r) => `${r.legacyId} -> ${r.newId}`);
  } finally {
    live.close();
  }
}

/**
 * One line naming every remap, for a receipt's reason.
 *
 * @param remaps - The remaps of a run.
 * @returns E.g. `1 legacy task(s) … recovered under new ids: legacy T001 ("old") -> T004, …`.
 * @example
 * ```ts
 * describeRemaps(remaps);
 * ```
 */
export function describeRemaps(remaps: readonly SupersededStoreIdRemap[]): string {
  const items = remaps.map(
    (r) =>
      `legacy ${r.legacyId} ("${r.legacyTitle}") -> ${r.newId}` +
      `${r.alreadyRecovered ? ' (already recovered)' : ''}, because live ${r.legacyId} is "${r.liveTitle}"`,
  );
  return `${remaps.length} legacy task(s) whose id a different live task holds, recovered under new ids: ${items.join('; ')} (${FREE_TEXT_IDS_NOTE})`;
}

/**
 * One line naming the collisions a run could not decide, for a receipt's reason.
 *
 * @param conflict - The undecided conflict.
 * @returns E.g. `2 legacy task(s) left uncopied (T001, T007): …`.
 * @example
 * ```ts
 * describeUndecided(result.undecided);
 * ```
 */
export function describeUndecided(conflict: SupersededStoreConflict): string {
  return (
    `${conflict.rows} legacy task(s) left uncopied (${(conflict.ids ?? []).join(', ')}): ` +
    'a live task holds the id and a creation time does not parse, so the run cannot tell ' +
    'whether they are the same task; keep .cleo/tasks.db'
  );
}
