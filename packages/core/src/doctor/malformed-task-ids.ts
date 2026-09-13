/**
 * `cleo doctor malformed-ids` — find and remove task rows the CLI cannot address.
 *
 * ## Why a doctor command rather than a normal delete
 *
 * A task id was written that no read path accepts. Found in a live store:
 *
 *     id    = '/mnt/projects/cleocode'
 *     title = 'Task /mnt/projects/cleocode'
 *     type  = null
 *
 * The row is **immortal**. `cleo list` enumerates it, but `cleo show`,
 * `cleo update` and `cleo delete` all reject the id as malformed *before* they
 * reach the store, so the ordinary way to remove a bad row cannot be used on
 * precisely the rows that need removing. The validators that should have
 * prevented the write are what make the result unfixable.
 *
 * T12128 closed the write path, so no new such row can be created. This closes
 * the other half: the ones already there.
 *
 * ## Why deletion is the right repair
 *
 * A row whose id is not an id has no identity — nothing can reference it,
 * `depends` cannot name it, and no evidence atom can cite it. Re-iding would
 * invent an identity the row never had and silently change what any existing
 * reference means. Deletion is honest, and the report prints the full row
 * first so the operator sees exactly what is being discarded.
 *
 * Read-only by default. `--fix` is required to delete anything.
 *
 * @module
 * @task T12128
 */

import { isStorableTaskId } from '@cleocode/contracts';
import { sql } from 'drizzle-orm';
import { openDualScopeDb } from '../store/dual-scope-db.js';

/**
 * Columns that hold a task id, by convention across the prefixed schema.
 *
 * Discovery is deliberately convention-based rather than FK-based. Only 11 of
 * the 18 referencing tables declare a foreign key to `tasks_tasks` — and
 * `tasks_lifecycle_pipelines`, which holds the dependent of the one malformed
 * row actually present in this repository's store, is **not** one of them. A
 * FK-only sweep would have reported "no dependents" for the live case.
 */
const TASK_ID_COLUMNS = [
  'task_id',
  'depends_on',
  'related_to',
  'target_task_id',
  'parent_id',
  'current_task',
] as const;

/** Rows in one table that reference a malformed id. */
export interface DependentRows {
  /** Table holding the references. */
  readonly table: string;
  /** Column holding them. */
  readonly column: string;
  /** How many rows reference the malformed id. */
  readonly count: number;
}

/** A task row whose id does not match the canonical shape. */
export interface MalformedTaskRow {
  /** The malformed id, verbatim. */
  readonly id: string;
  /** The row's title, for operator recognition. */
  readonly title: string | null;
  /** The row's status. */
  readonly status: string | null;
  /** The row's type, frequently `null` on these rows. */
  readonly type: string | null;
  /** Rows in `tasks_task_dependencies` that name this id on either side. */
  readonly dependencyRows: number;
  /**
   * Every reference to this id anywhere in the store, per table and column.
   *
   * The repair refuses while this is non-empty — see {@link scanMalformedTaskIds}.
   */
  readonly dependents: readonly DependentRows[];
}

/** Outcome of a {@link scanMalformedTaskIds} run. */
export interface MalformedTaskIdReport {
  /** Every row whose id fails {@link isStorableTaskId}. */
  readonly rows: readonly MalformedTaskRow[];
  /** `true` when `--fix` ran and rows were deleted. */
  readonly deleted: boolean;
  /**
   * Ids `--fix` REFUSED to delete because other tables reference them.
   *
   * Deleting a malformed row while leaving its references behind manufactures
   * exactly the violation `cleo doctor fk-check` exists to detect — one doctor
   * creating work for another. Found on real data: the single malformed row in
   * this repository's own store has a dependent row in
   * `tasks_lifecycle_pipelines`, a table with no declared foreign key.
   *
   * A blanket cascade is not the answer either: 18 tables hold a task id, and
   * they include `tasks_audit_log` and `tasks_task_work_history`, which are
   * evidence. Deleting the audit trail of a bad row destroys the record of how
   * it got there. Which references are safe to remove is an operator judgement,
   * so the repair reports them and stops.
   */
  readonly refused: readonly string[];
}

/**
 * Find task rows whose id could not be an identifier at all.
 *
 * Uses {@link isStorableTaskId}, NOT the canonical {@link isTaskId}. That
 * distinction is load-bearing: CLEO deliberately mints structured ids such as
 * `T-RECONCILE-FOLLOWUP-v2026.5.63-6` (see `archive-reason-invariant.ts`) which
 * the canonical pattern rejects. Reporting those here would be wrong, and
 * `--fix` would DELETE working release follow-up tasks.
 *
 * @param cwd - project root.
 * @param opts - `fix: true` deletes rows that nothing references; default is
 *               read-only. Rows WITH references are never deleted — see
 *               {@link MalformedTaskIdReport.refused}.
 * @returns the rows found, their references, and what was deleted or refused.
 *
 * @example
 * ```ts
 * const report = await scanMalformedTaskIds(projectRoot);
 * if (report.rows.length > 0) console.error('unaddressable rows present');
 * ```
 *
 * @task T12128
 */
export async function scanMalformedTaskIds(
  cwd: string,
  opts: { fix?: boolean } = {},
): Promise<MalformedTaskIdReport> {
  const { db } = await openDualScopeDb('project', cwd);

  // Every prefixed table holding a task-id-shaped column. Discovered from the
  // live schema rather than hardcoded, so a table added later is covered
  // automatically — the failure mode of a stale list here is a silent partial
  // repair, which is the very thing this command exists to avoid.
  const schemaRows = (await db.all(
    sql`SELECT m.name AS tbl, i.name AS col
        FROM sqlite_master AS m
        JOIN pragma_table_info(m.name) AS i
        WHERE m.type = 'table' AND m.name LIKE 'tasks_%'`,
  )) as ReadonlyArray<{ tbl: unknown; col: unknown }>;

  const refs = schemaRows
    .map((r) => ({ table: String(r.tbl), column: String(r.col) }))
    .filter((r) => (TASK_ID_COLUMNS as readonly string[]).includes(r.column));

  const all = (await db.all(
    sql`SELECT id, title, status, type FROM tasks_tasks`,
  )) as ReadonlyArray<{
    id: unknown;
    title: unknown;
    status: unknown;
    type: unknown;
  }>;

  const rows: MalformedTaskRow[] = [];
  for (const raw of all) {
    if (isStorableTaskId(raw.id)) continue;
    const id = String(raw.id);

    const dependents: DependentRows[] = [];
    for (const { table, column } of refs) {
      // `tasks_tasks.id` is the row itself, not a reference to it.
      if (table === 'tasks_tasks' && column !== 'parent_id') continue;

      const hit = (await db.all(
        sql`SELECT COUNT(*) AS c FROM ${sql.identifier(table)}
            WHERE ${sql.identifier(column)} = ${id}`,
      )) as ReadonlyArray<{ c?: number }>;

      const count = hit[0]?.c ?? 0;
      if (count > 0) dependents.push({ table, column, count });
    }

    rows.push({
      id,
      title: raw.title == null ? null : String(raw.title),
      status: raw.status == null ? null : String(raw.status),
      type: raw.type == null ? null : String(raw.type),
      dependencyRows: dependents
        .filter((d) => d.table === 'tasks_task_dependencies')
        .reduce((n, d) => n + d.count, 0),
      dependents,
    });
  }

  let deleted = false;
  const refused = rows.filter((r) => r.dependents.length > 0);

  if (opts.fix && rows.length > 0 && refused.length === 0) {
    // One transaction: a partially-repaired store is worse than an unrepaired
    // one, because the operator would then have to re-derive which rows were
    // left behind — and these are the rows no query can name.
    await db.run(sql`BEGIN`);
    try {
      for (const row of rows) {
        await db.run(sql`DELETE FROM tasks_tasks WHERE id = ${row.id}`);
      }
      await db.run(sql`COMMIT`);
      deleted = true;
    } catch (err) {
      await db.run(sql`ROLLBACK`);
      throw err;
    }
  }

  return { rows, deleted, refused: refused.map((r) => r.id) };
}
