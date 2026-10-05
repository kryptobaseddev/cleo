/**
 * The typed merge-rule registry (T12344; journal spec §3.6, inventory
 * `t12859-sync-write-validator-inventory` §3.6.6).
 *
 * Each entry gives a sync-set table's counters, LWW groups and typed rules;
 * the applier adds the live column list ({@link mergeSpecFor}). A table without
 * an entry merges every column by plain per-field LWW. The rule ids match the
 * `monotonic-merge-rule` entries of the sync write-invariant registry
 * (`@cleocode/contracts` `SYNC_WRITE_INVARIANTS`), so the gate can see which
 * rules are implemented.
 *
 * This slice implements the three task rules (T12937, T12938, T12939); the
 * rest of §3.6.6 lands rule by rule on the same mechanism.
 *
 * Explicit ops (`TASK_STATUS_LEAVE_OPS`, `TASK_STAGE_RESTORE_OPS`) are
 * granted per TRANSACTION, not per row: every op of a restore or reopen
 * transaction may leave a terminal status or lower a stage, on any row it
 * writes. That is intended: a restore cascades to the task's children inside
 * the same transaction, and the cascade must not be voided on receivers.
 *
 * Groups are part of the wire contract (T13222): see {@link mergeGroupsOf}.
 * Sealer shape, settled from real sealer output (`apply-intent.test.ts`,
 * "real sealer output"): before T13222 the capture trigger recorded only the
 * changed columns, so a done sealed as {status, completed_at} and a cancel as
 * {status, completed_at, cancelled_at, cancellation_reason}. Since T13222
 * every U touching a group carries all four members, unchanged ones
 * included, so the engine never fills an uncarried member: there is no NULL
 * reset, and a lone correction of `completed_at` travels with the status it
 * belongs to. A partial-group U is refused as malformed.
 *
 * @module store/sync/merge/rules
 * @task T12344
 */

import { TERMINAL_TASK_STATUSES } from '@cleocode/contracts/status-registry.js';
import { PIPELINE_STAGES } from '../../../lifecycle/stages.js';
import type { TableMergeSpec } from './types.js';

/** A table's merge rules, without its live column list. */
export type MergeRuleSet = Omit<TableMergeSpec, 'columns'>;

/**
 * The `actor.op` values that may leave a terminal task status: today's
 * `validateStatusTransition` table allows done → pending/active and
 * cancelled → pending only through restore (alias reopen, uncancel).
 */
export const TASK_STATUS_LEAVE_OPS: readonly string[] = [
  'tasks.restore',
  'tasks.reopen',
  'tasks.uncancel',
  'tasks.unarchive',
];

/** The `actor.op` values that may move `pipeline_stage` backwards. */
export const TASK_STAGE_RESTORE_OPS: readonly string[] = ['tasks.restore', 'tasks.reopen'];

/**
 * The rank order of `pipeline_stage` for the merge: the pipeline, then the
 * two terminal stages a terminal status requires (T877: done needs
 * contribution or cancelled, cancelled needs cancelled). They rank highest so
 * a completion or cancel is never dropped by the stage max, and `cancelled`
 * above `contribution` so that whichever terminal status wins its LWW, the
 * merged stage satisfies the T877 trigger (done accepts cancelled).
 *
 * Local lowering: the domain refuses a backward stage move (T060,
 * `validatePipelineTransition`); only restore and reopen lower a stage, and
 * they name a restore op, so the origin and its receivers never disagree.
 */
export const TASK_STAGE_MERGE_ORDER: readonly string[] = [
  ...PIPELINE_STAGES,
  'contribution',
  'cancelled',
];

/**
 * The typed merge rules by sync-set table. Implemented rule ids:
 * `task.status.absorbing` (T12937), `task.pipeline-stage.max` (T12938),
 * `task.verification.frozen-on-done` (T12939).
 */
export const SYNC_MERGE_RULES: Readonly<Record<string, MergeRuleSet>> = {
  tasks_tasks: {
    // Status and its stamps move together, taken from the winning op.
    groups: [['status', 'completed_at', 'cancelled_at', 'cancellation_reason']],
    // A terminal status fixes the stage (T13243, matching the domain: complete
    // sets contribution, cancel sets cancelled, T871/T877): after a cancel and
    // a completion race, status and stage always agree, whichever status won.
    coupled: [
      {
        column: 'pipeline_stage',
        status: 'status',
        map: { done: 'contribution', cancelled: 'cancelled' },
      },
    ],
    rules: {
      status: {
        kind: 'absorbing',
        id: 'task.status.absorbing',
        states: [...TERMINAL_TASK_STATUSES],
        leaveOps: TASK_STATUS_LEAVE_OPS,
      },
      pipeline_stage: {
        kind: 'rank-max',
        id: 'task.pipeline-stage.max',
        order: TASK_STAGE_MERGE_ORDER,
        restoreOps: TASK_STAGE_RESTORE_OPS,
      },
      verification_json: {
        kind: 'frozen-while',
        id: 'task.verification.frozen-on-done',
        column: 'status',
        values: ['done'],
        unfreezeOps: TASK_STATUS_LEAVE_OPS,
      },
    },
  },
};

/** The rule ids this registry implements, for the write-invariant gate. */
export function implementedMergeRuleIds(): string[] {
  const ids: string[] = [];
  for (const set of Object.values(SYNC_MERGE_RULES)) {
    for (const rule of Object.values(set.rules ?? {})) ids.push(rule.id);
  }
  return ids.sort();
}

/**
 * The merge spec of `table` for a store whose schema has `columns`.
 *
 * @param table - Sync-set table name.
 * @param columns - The table's live column names.
 * @returns The table's spec; plain per-field LWW when it has no entry.
 */
export function mergeSpecFor(table: string, columns: readonly string[]): TableMergeSpec {
  return { ...(SYNC_MERGE_RULES[table] ?? {}), columns };
}

/**
 * The merge groups of `table` that `columns` touches, each listed whole
 * (T13222). A group travels whole on the wire: the capture trigger records
 * every column of a group when any of them changes, apply-intent subtraction
 * keeps a group whole when any of its columns is residual, and the engine
 * refuses a U op that carries part of a group. So a winning group op sets
 * every column of its group, in every order.
 *
 * @param table - Sync-set table name.
 * @param columns - Columns of interest (a schema's columns, or an image's).
 * @returns The groups with at least one member in `columns`, restricted to
 *   the members in `columns`.
 */
export function mergeGroupsOf(table: string, columns: readonly string[]): string[][] {
  const out: string[][] = [];
  for (const g of SYNC_MERGE_RULES[table]?.groups ?? []) {
    const present = g.filter((c) => columns.includes(c));
    if (present.length > 0) out.push(present);
  }
  return out;
}
