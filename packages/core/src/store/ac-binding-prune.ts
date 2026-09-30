/**
 * Evidence ↔ AC binding pruning — the single write path that removes
 * `tasks_evidence_ac_bindings` rows (T12790).
 *
 * ## Why this exists
 *
 * The consolidated project schema (`drizzle-cleo-project/20260531000001`)
 * declares NO foreign key from `tasks_evidence_ac_bindings.ac_id` to
 * `tasks_task_acceptance_criteria.id`. The legacy table's `ON DELETE CASCADE`
 * did not survive consolidation, so every AC row that left the store —
 * through an AC edit ({@link import('../tasks/ac-table.js').applyAcPlan}) or a
 * hard task delete (the AC rows cascade from `tasks_tasks`) — left its
 * bindings dangling. Adding the FK back would need a table rebuild, so the
 * accessor deletes the bindings explicitly instead, in the same transaction
 * that removes the AC rows.
 *
 * ## History is kept in the audit log, not in the bindings table
 *
 * One reader depends on historical bindings: alias-drift detection in
 * `satisfies-validator.ts` (ADR-079-r2 §3) compares an alias atom's current
 * AC against the AC a previous `satisfies` binding recorded. A binding for a
 * removed AC is meaningless to the coverage gate, but it is exactly the
 * record that says "alias AC2 used to mean X". So before a binding is
 * deleted, its full row is written to `tasks_audit_log` under
 * {@link AC_BINDINGS_PRUNED_ACTION}, keyed by the task that owned the AC, and
 * the drift detector reads those rows as well as the live table.
 *
 * Every function takes the drizzle handle of an ALREADY-OPEN accessor
 * transaction; none of them opens or commits one.
 *
 * @task T12790
 * @adr ADR-079-r2
 */

import type { AcBindingRow } from '@cleocode/contracts';
import { and, eq, inArray, isNotNull, isNull, notInArray, or } from 'drizzle-orm';
import { tasksAuditLog } from './schema/cleo-project/audit.js';
import type { getDb } from './sqlite.js';
import * as schema from './tasks-schema.js';

/** Drizzle handle for the project tasks store. */
type TasksDb = Awaited<ReturnType<typeof getDb>>;

/** `tasks_audit_log.action` recorded for every batch of pruned bindings. */
export const AC_BINDINGS_PRUNED_ACTION = 'ac.bindings.pruned';

/**
 * Why a batch of bindings was pruned.
 *
 *   - `ac-removed`    — the AC rows left the task's set in an AC edit.
 *   - `task-removed`  — the owning task was hard-deleted (its AC rows cascade).
 *   - `orphan-repair` — `cleo doctor ac-bindings --fix` removed rows whose AC
 *                       was already gone before T12790.
 */
export type AcBindingPruneReason = 'ac-removed' | 'task-removed' | 'orphan-repair';

/** `details` payload of a {@link AC_BINDINGS_PRUNED_ACTION} audit row. */
export interface AcBindingsPrunedDetails {
  /** Why the bindings were removed. */
  readonly reason: AcBindingPruneReason;
  /** The AC ids whose bindings were removed. */
  readonly acIds: readonly string[];
  /** The removed binding rows, verbatim. */
  readonly bindings: readonly AcBindingRow[];
}

/** Owner key used when an orphan's owning task cannot be inferred. */
export const UNKNOWN_BINDING_OWNER = 'unknown';

/** Map a selected drizzle row to the contracts shape. */
function toBindingRow(r: {
  id: string;
  evidenceAtomId: string;
  acId: string;
  bindingType: 'direct' | 'satisfies' | 'coverage';
  createdAt: string;
}): AcBindingRow {
  return {
    id: r.id,
    evidenceAtomId: r.evidenceAtomId,
    acId: r.acId,
    bindingType: r.bindingType,
    createdAt: r.createdAt,
  };
}

const BINDING_COLUMNS = {
  id: schema.evidenceAcBindings.id,
  evidenceAtomId: schema.evidenceAcBindings.evidenceAtomId,
  acId: schema.evidenceAcBindings.acId,
  bindingType: schema.evidenceAcBindings.bindingType,
  createdAt: schema.evidenceAcBindings.createdAt,
};

/**
 * Generate a task audit log row id in the `log-<epoch>-<rand>` shape.
 *
 * Shared by the task accessor's `appendLog` and the binding prune below, so
 * both write ids of one shape.
 *
 * @task T4837 · T12790
 */
export function generateAuditLogId(): string {
  const epoch = Math.floor(Date.now() / 1000);
  const rand = Math.random().toString(36).slice(2, 8);
  return `log-${epoch}-${rand}`;
}

/**
 * Record `bindings` in the audit log, then delete them — one audit row for
 * the batch. No-op when `bindings` is empty.
 */
async function archiveAndDelete(
  db: TasksDb,
  ownerTaskId: string,
  reason: AcBindingPruneReason,
  bindings: readonly AcBindingRow[],
): Promise<void> {
  if (bindings.length === 0) return;
  const details: AcBindingsPrunedDetails = {
    reason,
    acIds: [...new Set(bindings.map((b) => b.acId))],
    bindings,
  };
  await db
    .insert(tasksAuditLog)
    .values({
      id: generateAuditLogId(),
      timestamp: new Date().toISOString(),
      action: AC_BINDINGS_PRUNED_ACTION,
      taskId: ownerTaskId,
      actor: 'system',
      detailsJson: JSON.stringify(details),
      beforeJson: null,
      afterJson: null,
      sessionId: null,
    })
    .run();
  await db
    .delete(schema.evidenceAcBindings)
    .where(
      inArray(
        schema.evidenceAcBindings.id,
        bindings.map((b) => b.id),
      ),
    )
    .run();
}

/**
 * Delete every binding whose `ac_id` is in `acIds`, recording them first in
 * the audit log under `ownerTaskId` (the task that owned those ACs).
 *
 * Call it in the same transaction that removes the AC rows, BEFORE or AFTER
 * the AC delete — the bindings table has no FK, so order does not matter.
 *
 * @param db - drizzle handle of the open accessor transaction
 * @param ownerTaskId - task that owned the removed ACs
 * @param acIds - AC ids leaving the store
 * @param reason - why they are leaving
 * @returns number of bindings removed
 *
 * @task T12790
 */
export async function pruneAcBindingsForAcIds(
  db: TasksDb,
  ownerTaskId: string,
  acIds: readonly string[],
  reason: AcBindingPruneReason,
  keepBindingsForUids: readonly string[] = [],
): Promise<number> {
  if (acIds.length === 0) return 0;
  // T12341: a binding follows its criterion's uid (`ac_uid`) across edits, so
  // the bindings of a removed row are also those recorded under an older id of
  // the same criterion; and a row whose uid the same write carries onto a new
  // row (an edit) is not leaving, so its bindings stay (stale until re-verified).
  const uids = (
    await db
      .select({ uid: schema.taskAcceptanceCriteria.uid })
      .from(schema.taskAcceptanceCriteria)
      .where(inArray(schema.taskAcceptanceCriteria.id, acIds as string[]))
      .all()
  )
    .map((r) => r.uid)
    .filter((u): u is string => u !== null);
  const keep = new Set(keepBindingsForUids);
  const rows = await db
    .select({ ...BINDING_COLUMNS, acUid: schema.evidenceAcBindings.acUid })
    .from(schema.evidenceAcBindings)
    .where(
      uids.length > 0
        ? or(
            inArray(schema.evidenceAcBindings.acId, acIds as string[]),
            inArray(schema.evidenceAcBindings.acUid, uids),
          )
        : inArray(schema.evidenceAcBindings.acId, acIds as string[]),
    )
    .all();
  const bindings = rows.filter((r) => r.acUid === null || !keep.has(r.acUid)).map(toBindingRow);
  await archiveAndDelete(db, ownerTaskId, reason, bindings);
  return bindings.length;
}

/**
 * Delete the bindings of every AC `taskId` owns — the hard task-delete path
 * (the AC rows go by `ON DELETE CASCADE` from `tasks_tasks`) and the
 * delete-every-AC-row path.
 *
 * @param db - drizzle handle of the open accessor transaction
 * @param taskId - task whose AC rows are all leaving
 * @param reason - `task-removed` (default) or `ac-removed`
 * @returns number of bindings removed
 *
 * @task T12790
 */
export async function pruneAcBindingsForTask(
  db: TasksDb,
  taskId: string,
  reason: AcBindingPruneReason = 'task-removed',
): Promise<number> {
  const acRows = await db
    .select({ id: schema.taskAcceptanceCriteria.id })
    .from(schema.taskAcceptanceCriteria)
    .where(eq(schema.taskAcceptanceCriteria.taskId, taskId))
    .all();
  return pruneAcBindingsForAcIds(
    db,
    taskId,
    acRows.map((r) => r.id),
    reason,
  );
}

/**
 * Read every binding whose `ac_id` names no row of
 * `tasks_task_acceptance_criteria`. Read-only.
 *
 * @param db - drizzle handle for the project tasks store
 * @returns the dangling bindings, oldest first
 *
 * @task T12790
 */
export async function selectOrphanAcBindings(db: TasksDb): Promise<AcBindingRow[]> {
  const rows = await db
    .select(BINDING_COLUMNS)
    .from(schema.evidenceAcBindings)
    .where(
      and(
        notInArray(
          schema.evidenceAcBindings.acId,
          db.select({ id: schema.taskAcceptanceCriteria.id }).from(schema.taskAcceptanceCriteria),
        ),
        // T12341: a binding recorded under an older id of a criterion that
        // still exists (same `ac_uid`) is stale evidence, not an orphan.
        or(
          isNull(schema.evidenceAcBindings.acUid),
          notInArray(
            schema.evidenceAcBindings.acUid,
            db
              .select({ uid: schema.taskAcceptanceCriteria.uid })
              .from(schema.taskAcceptanceCriteria)
              .where(isNotNull(schema.taskAcceptanceCriteria.uid)),
          ),
        ),
      ),
    )
    .orderBy(schema.evidenceAcBindings.createdAt, schema.evidenceAcBindings.id)
    .all();
  return rows.map(toBindingRow);
}

/**
 * Infer the task that owned an orphan binding's AC.
 *
 * Only `satisfies:<source>-><target>#<ac>` atom ids name it (the target owns
 * the AC). Every other atom shape yields {@link UNKNOWN_BINDING_OWNER}.
 *
 * @param binding - an orphan binding
 * @returns owning task id, or `'unknown'`
 *
 * @task T12790
 */
export function inferBindingOwnerTask(binding: AcBindingRow): string {
  const match = /^satisfies:[^>]*->([^#]+)#/.exec(binding.evidenceAtomId);
  return match?.[1] ?? UNKNOWN_BINDING_OWNER;
}

/**
 * Remove every orphan binding, one audit row per inferred owning task.
 *
 * @param db - drizzle handle of the open accessor transaction
 * @returns the removed bindings
 *
 * @task T12790
 */
export async function pruneOrphanAcBindings(db: TasksDb): Promise<AcBindingRow[]> {
  const orphans = await selectOrphanAcBindings(db);
  const byOwner = new Map<string, AcBindingRow[]>();
  for (const row of orphans) {
    const owner = inferBindingOwnerTask(row);
    const group = byOwner.get(owner);
    if (group) group.push(row);
    else byOwner.set(owner, [row]);
  }
  for (const [owner, group] of byOwner) {
    await archiveAndDelete(db, owner, 'orphan-repair', group);
  }
  return orphans;
}

/** Narrow a parsed JSON value to an {@link AcBindingRow}. */
function isBindingRow(value: object | null): value is AcBindingRow {
  if (value === null) return false;
  const row = value as Partial<Record<keyof AcBindingRow, string | number | boolean | object>>;
  return (
    typeof row.id === 'string' &&
    typeof row.evidenceAtomId === 'string' &&
    typeof row.acId === 'string' &&
    (row.bindingType === 'direct' ||
      row.bindingType === 'satisfies' ||
      row.bindingType === 'coverage') &&
    typeof row.createdAt === 'string'
  );
}

/**
 * Read the bindings that were pruned from ACs owned by `ownerTaskId`, from
 * their {@link AC_BINDINGS_PRUNED_ACTION} audit rows. Read-only.
 *
 * This is where binding history lives once the rows leave
 * `tasks_evidence_ac_bindings`; alias-drift detection reads it.
 *
 * @param db - drizzle handle for the project tasks store
 * @param ownerTaskId - task that owned the pruned ACs
 * @returns the pruned binding rows (malformed audit payloads are skipped)
 *
 * @task T12790
 */
export async function selectPrunedAcBindings(
  db: TasksDb,
  ownerTaskId: string,
): Promise<AcBindingRow[]> {
  const rows = await db
    .select({ detailsJson: tasksAuditLog.detailsJson })
    .from(tasksAuditLog)
    .where(
      and(
        eq(tasksAuditLog.action, AC_BINDINGS_PRUNED_ACTION),
        eq(tasksAuditLog.taskId, ownerTaskId),
      ),
    )
    .all();
  const out: AcBindingRow[] = [];
  for (const row of rows) {
    if (typeof row.detailsJson !== 'string') continue;
    let parsed: { bindings?: ReadonlyArray<object | null> } | null;
    try {
      parsed = JSON.parse(row.detailsJson) as { bindings?: ReadonlyArray<object | null> } | null;
    } catch {
      continue;
    }
    const bindings = parsed?.bindings;
    if (!Array.isArray(bindings)) continue;
    for (const b of bindings) if (isBindingRow(b)) out.push(b);
  }
  return out;
}
