/**
 * Post-cutover provenance `task_id` / `epic_id` FK reconciliation (DHQ-051).
 *
 * Shared between `cleo release reconcile` ({@link releaseReconcileV2}) and
 * `cleo release plan` ({@link releasePlan} → `upsertReleasesRow`). Both verbs
 * write provenance rows (`task_commits`, `pr_tasks`, `releases`,
 * `release_changes`) whose `task_id` / `epic_id` foreign keys reference the
 * BARE `tasks` table — which is empty on a consolidated dual-scope `cleo.db`
 * after the T11578 cutover (runtime task data moved to the prefixed
 * `tasks_tasks` table). A row inserted with an `epicId` / `taskId` that exists
 * only in `tasks_tasks` violates the FK at INSERT time, aborting the verb.
 *
 * This module is the single source of truth for the FK-ordered parent backfill
 * that makes those FKs satisfiable. `reconcile.ts` re-exports both symbols so
 * its public surface is unchanged.
 *
 * @task T11659 — reconcile slice (original)
 * @task T11818 — plan/open slice (DRY hoist)
 * @epic T11466
 */

import { getLogger } from '../logger.js';
import type { DatabaseSync } from '../store/sqlite.js';

const log = getLogger('release:provenance-fk');

/** Result of resolving + reconciling the provenance `task_id` FK parent table. */
export interface FkParentTaskResolution {
  /** Physical table the provenance `task_id` FK references, or null if absent. */
  parentTable: string | null;
  /**
   * Task IDs the FK can now resolve (FK parent rows present after any
   * FK-ordered shim backfill). A `task_id` reference to an id in this set is
   * safe to INSERT under strict FK enforcement.
   */
  resolvableIds: Set<string>;
}

/**
 * Make the provenance `task_id` foreign keys satisfiable on a consolidated
 * `cleo.db` by inserting any missing FK-parent rows in FK order (parent-before
 * -child), then returning the set of IDs the FK can resolve.
 *
 * ## Background (DHQ-051 · T11659 / T11818 — same class as DHQ-045)
 *
 * After the dual-scope `cleo.db` cutover (T11578) the runtime task store moved
 * from the bare `tasks` table to the prefixed `tasks_tasks` table. The drizzle
 * `schema.tasks` symbol is shadowed at the barrel (`tasks-schema.ts`) onto
 * `tasks_tasks`, so token-validity probes read the populated prefixed table.
 * BUT the provenance tables (`task_commits`, `pr_tasks`, `releases`,
 * `release_changes`) predate the cutover — their `task_id` / `epic_id` FKs
 * still reference the BARE `tasks` table, which is empty on a consolidated
 * `cleo.db`. A token validated against `tasks_tasks` therefore passes the
 * legacy gate yet violates the FK at INSERT time, aborting the whole verb with
 * `E_PROVENANCE_FAILED` (reconcile) or `E_INTERNAL` (plan).
 *
 * ## Strategy — FK-ordered parent backfill (Strategy 1)
 *
 * For every task referenced by this release we ensure a row exists in the FK
 * parent table BEFORE the child provenance rows are written. The parent table
 * is discovered dynamically via `PRAGMA foreign_key_list('task_commits')` (so
 * the logic tracks whatever the live schema enforces — including a future
 * schema that repoints the FK at `tasks_tasks`, where this becomes a no-op).
 * Missing parent rows are copied from the runtime `tasks_tasks` store via
 * `INSERT OR IGNORE … SELECT` of only the NOT NULL columns, so the copied rows
 * satisfy the parent table's own CHECK/NOT NULL constraints. Tasks that exist
 * in neither table remain unresolvable and are skipped-with-warn / NULLed by
 * the callers (the row, never the whole verb).
 *
 * Idempotent: `INSERT OR IGNORE` never duplicates and never overwrites an
 * existing parent row. Callers run it inside their write transaction so a later
 * failure rolls the shim rows back too.
 *
 * @param nativeDb - The consolidated `cleo.db` native handle.
 * @param referencedIds - Every task id this verb may reference (commit tokens,
 *   PR tokens, plan tasks, epic).
 * @returns The FK parent table name + the IDs it can now resolve.
 */
export function ensureProvenanceTaskFkParents(
  nativeDb: DatabaseSync,
  referencedIds: ReadonlySet<string>,
): FkParentTaskResolution {
  // Discover the physical parent table the `task_commits.task_id` FK targets.
  let parentTable = 'tasks';
  try {
    const fks = nativeDb.prepare(`PRAGMA foreign_key_list('task_commits')`).all() as Array<{
      table: string;
      from: string;
    }>;
    const taskFk = fks.find((fk) => fk.from === 'task_id');
    if (taskFk?.table) parentTable = taskFk.table;
  } catch {
    // PRAGMA unavailable (table absent / older sqlite) — keep the bare default.
  }

  const tableExists = (name: string): boolean =>
    nativeDb.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name) !=
    null;

  // Parent table absent entirely → nothing resolvable, nothing to backfill.
  if (!tableExists(parentTable)) {
    return { parentTable: null, resolvableIds: new Set<string>() };
  }

  // FK-ordered shim backfill: copy any referenced task that lives in the
  // runtime `tasks_tasks` store but is missing from the FK parent. Only when
  // the parent is the bare legacy table AND the prefixed store exists (i.e. the
  // post-cutover split-brain) — when the FK already points at `tasks_tasks`
  // this is skipped and the parent is read as-is.
  // Identifiers come from sqlite_master / the FK pragma (verified existing
  // table names), never user input — safe to interpolate (node:sqlite exposes
  // no bound-identifier form). All VALUES are bound parameters.
  if (parentTable !== 'tasks_tasks' && tableExists('tasks_tasks') && referencedIds.size > 0) {
    // `pipeline_stage` is copied alongside the NOT NULL columns so the bare
    // `tasks` table's T877 invariant trigger (status='done' ⇒ pipeline_stage IN
    // ('contribution','cancelled'); status='cancelled' ⇒ pipeline_stage=
    // 'cancelled') is satisfied. A released epic is typically status='done', so
    // omitting `pipeline_stage` would RAISE(ABORT) the shim copy and leave the
    // epic unresolvable (DHQ-051 · T11818).
    const insertShim = nativeDb.prepare(
      `INSERT OR IGNORE INTO "${parentTable}" (id, title, status, priority, role, scope, pipeline_stage)
       SELECT id, title, status, priority, role, scope, pipeline_stage FROM tasks_tasks WHERE id = ?`,
    );
    for (const id of referencedIds) {
      try {
        insertShim.run(id);
      } catch (err) {
        // A single shim copy that violates the parent's own constraints (e.g. a
        // NOT NULL / CHECK the prefixed row does not satisfy) must NOT abort the
        // whole verb. Leave the id unresolvable — the writers below
        // skip-with-warn that one link (Strategy 3). SAVEPOINT-free: the failed
        // statement is rolled back individually by SQLite, leaving the
        // surrounding transaction intact.
        log.warn(
          { taskId: id, parentTable, err: err instanceof Error ? err.message : String(err) },
          'provenance: FK-parent shim copy failed — task_id stays unresolvable, link will be skipped',
        );
      }
    }
  }

  // Read back what the FK can now resolve.
  const resolvableIds = new Set<string>();
  const rows = nativeDb.prepare(`SELECT id FROM "${parentTable}"`).all() as Array<{ id: unknown }>;
  for (const r of rows) {
    if (typeof r.id === 'string') resolvableIds.add(r.id);
  }
  return { parentTable, resolvableIds };
}
