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
 * The typed merge rules by sync-set table. Implemented rule ids:
 * `task.status.absorbing` (T12937), `task.pipeline-stage.max` (T12938),
 * `task.verification.frozen-on-done` (T12939).
 */
export const SYNC_MERGE_RULES: Readonly<Record<string, MergeRuleSet>> = {
  tasks_tasks: {
    // Status and its stamps move together, taken from the winning op.
    groups: [['status', 'completed_at', 'cancelled_at', 'cancellation_reason']],
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
        order: PIPELINE_STAGES,
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
