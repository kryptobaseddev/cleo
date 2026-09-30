/**
 * `cleo doctor ac-bindings` — evidence bindings whose acceptance criterion is gone.
 *
 * `tasks_evidence_ac_bindings.ac_id` has no foreign key to
 * `tasks_task_acceptance_criteria` in the consolidated schema, so before
 * T12790 every AC removed by an edit, and every AC cascaded away by a hard
 * task delete, left its bindings behind. Those rows are meaningless to the
 * coverage gate (it only reads bindings of ACs that exist) but they are not
 * harmless: they count as evidence nobody can see and they inflate every
 * scan of the table.
 *
 * T12790 prunes bindings together with their AC going forward. This check
 * finds the rows already left behind. It is read-only by default; `--fix`
 * removes them in one accessor transaction, writing each removed row to the
 * task audit log (`ac.bindings.pruned`, reason `orphan-repair`) first, so the
 * binding history alias-drift detection relies on is preserved.
 *
 * @module
 * @task T12790
 */

import type { AcBindingRow } from '@cleocode/contracts';
import { getTaskAccessor } from '../store/data-accessor.js';

/** Orphan count for one binding type. */
export interface OrphanAcBindingTypeCount {
  /** `direct`, `satisfies` or `coverage`. */
  readonly bindingType: AcBindingRow['bindingType'];
  /** Orphaned rows of that type. */
  readonly count: number;
}

/** Outcome of {@link scanOrphanAcBindings}. */
export interface OrphanAcBindingsReport {
  /** Number of bindings whose AC no longer exists (before any repair). */
  readonly orphanCount: number;
  /** {@link orphanCount} split by binding type. */
  readonly byType: readonly OrphanAcBindingTypeCount[];
  /** Distinct missing AC ids the orphans point at. */
  readonly missingAcIds: readonly string[];
  /** The orphan rows themselves (capped by `limit`). */
  readonly orphans: readonly AcBindingRow[];
  /** `true` when `--fix` ran. */
  readonly repaired: boolean;
  /** Rows removed by `--fix` (0 when read-only). */
  readonly removed: number;
}

/**
 * Find — and with `fix: true`, remove — bindings whose AC row is gone.
 *
 * @param cwd - project root
 * @param opts - `fix: true` removes the orphans (audited); `limit` caps the
 *               rows echoed in the report (default 50; counts are exact)
 * @returns what was found and what was removed
 *
 * @example
 * ```ts
 * const report = await scanOrphanAcBindings(projectRoot);
 * if (report.orphanCount > 0) console.error('dangling evidence bindings');
 * ```
 *
 * @task T12790
 */
export async function scanOrphanAcBindings(
  cwd: string,
  opts: { fix?: boolean; limit?: number } = {},
): Promise<OrphanAcBindingsReport> {
  const accessor = await getTaskAccessor(cwd);
  const found = await accessor.findOrphanAcBindings();
  let removed = 0;
  if (opts.fix === true && found.length > 0) {
    const pruned = await accessor.transaction((tx) => tx.pruneOrphanAcBindings());
    removed = pruned.length;
  }

  const counts = new Map<AcBindingRow['bindingType'], number>();
  for (const row of found) counts.set(row.bindingType, (counts.get(row.bindingType) ?? 0) + 1);
  const limit = Math.max(0, Math.floor(opts.limit ?? 50));

  return {
    orphanCount: found.length,
    byType: [...counts].map(([bindingType, count]) => ({ bindingType, count })),
    missingAcIds: [...new Set(found.map((row) => row.acId))],
    orphans: found.slice(0, limit),
    repaired: opts.fix === true,
    removed,
  };
}
