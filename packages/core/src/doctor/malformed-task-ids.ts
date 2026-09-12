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
}

/** Outcome of a {@link scanMalformedTaskIds} run. */
export interface MalformedTaskIdReport {
  /** Every row whose id fails {@link isStorableTaskId}. */
  readonly rows: readonly MalformedTaskRow[];
  /** `true` when `--fix` ran and rows were deleted. */
  readonly deleted: boolean;
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
 * @param opts - `fix: true` deletes the rows found; default is read-only.
 * @returns the rows found, and whether they were deleted.
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

    const dep = (await db.all(
      sql`SELECT COUNT(*) AS c FROM tasks_task_dependencies
          WHERE task_id = ${id} OR depends_on = ${id}`,
    )) as ReadonlyArray<{ c?: number }>;

    rows.push({
      id,
      title: raw.title == null ? null : String(raw.title),
      status: raw.status == null ? null : String(raw.status),
      type: raw.type == null ? null : String(raw.type),
      dependencyRows: dep[0]?.c ?? 0,
    });
  }

  let deleted = false;
  if (opts.fix && rows.length > 0) {
    // One transaction: a partially-repaired store is worse than an unrepaired
    // one, because the operator would then have to re-derive which rows were
    // left behind — and these rows are precisely the ones no query can name.
    await db.run(sql`BEGIN`);
    try {
      for (const row of rows) {
        await db.run(
          sql`DELETE FROM tasks_task_dependencies
              WHERE task_id = ${row.id} OR depends_on = ${row.id}`,
        );
        await db.run(sql`DELETE FROM tasks_tasks WHERE id = ${row.id}`);
      }
      await db.run(sql`COMMIT`);
      deleted = true;
    } catch (err) {
      await db.run(sql`ROLLBACK`);
      throw err;
    }
  }

  return { rows, deleted };
}
