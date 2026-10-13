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
 * cancelled → pending only through restore. Each name is emitted by core's
 * own entry point (`taskRestore` for cancelled, `taskReopen` for done,
 * `taskUnarchive` for archived; T13229), whatever the transport; a test
 * keeps the two in sync.
 */
export const TASK_STATUS_LEAVE_OPS: readonly string[] = [
  'tasks.restore',
  'tasks.reopen',
  'tasks.unarchive',
];

/**
 * Release statuses a sync merge never takes back (T12943, inventory REL-2..8):
 * the shipped ones (committed, tagged, pushed, published, reconciled) and a
 * rollback. A late `planned` from a re-plan (REL-8) or any other pre-ship
 * write is refused once one of these is merged; moves among them (tagged →
 * pushed, committed vs rolled_back) resolve by LWW. No command leaves them.
 */
export const RELEASE_ABSORBING_STATUSES: readonly string[] = [
  'committed',
  'tagged',
  'pushed',
  'published',
  'reconciled',
  'rolled_back',
];

/** A release's status stamps, which travel with the status (REL-7). */
export const RELEASE_STATUS_GROUP: readonly string[] = [
  'status',
  'planned_at',
  'pr_opened_at',
  'pr_merged_at',
  'published_at',
  'reconciled_at',
  'rolled_back_at',
  'failed_at',
  'cancelled_at',
  'prepared_at',
  'committed_at',
  'tagged_at',
  'pushed_at',
];

/**
 * The `actor.op` values that may leave a terminal session status (T12940):
 * resume, switch and a snapshot restore reactivate an ended or orphaned
 * session. Each is emitted by core's own entry points (`sessionResume` — the
 * `cleo session resume` path — and `resumeSession`, `switchSession`,
 * `restoreSession`); a test keeps the two in sync.
 */
export const SESSION_STATUS_LEAVE_OPS: readonly string[] = [
  'session.resume',
  'session.switch',
  'session.restore',
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
 * `task.verification.frozen-on-done` (T12939),
 * `docs.decision-adr-links.revoke-monotonic` (T13597),
 * `audit.immutable` (T12941, table-level), `playbook.approval.once` (T12944),
 * `session.status.terminal` (T12940), `release.status.absorbing` (T12943),
 * `sticky.status.one-way` (T12942), `docs.lifecycle.transitions` (T12945).
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
  tasks_releases: {
    groups: [RELEASE_STATUS_GROUP],
    rules: {
      status: {
        kind: 'absorbing',
        id: 'release.status.absorbing',
        states: RELEASE_ABSORBING_STATUSES,
        leaveOps: [],
      },
    },
  },
  tasks_sessions: {
    // The status and its end stamp move together (a resume clears ended_at).
    groups: [['status', 'ended_at']],
    rules: {
      status: {
        kind: 'absorbing',
        id: 'session.status.terminal',
        states: ['ended', 'orphaned'],
        leaveOps: SESSION_STATUS_LEAVE_OPS,
      },
    },
  },
  // Audit rows are immutable once written (T12941, SA3), on both twins.
  tasks_audit_log: { immutable: 'audit.immutable' },
  audit_log: { immutable: 'audit.immutable' },
  tasks_playbook_approvals: {
    // A decision and its stamps move together (PB-1).
    groups: [['status', 'approved_at', 'approver', 'reason']],
    rules: {
      // pending → approved | rejected once (T12944); no command reopens a
      // decision. Two devices deciding differently resolve by LWW and record
      // the divergent decision as a conflict.
      status: {
        kind: 'absorbing',
        id: 'playbook.approval.once',
        states: ['approved', 'rejected'],
        leaveOps: [],
      },
    },
  },
  // The live writers (playbooks/src) write the bare twin; both sync (T12944).
  playbook_approvals: {
    // A decision and its stamps move together (PB-1).
    groups: [['status', 'approved_at', 'approver', 'reason']],
    rules: {
      // pending → approved | rejected once (T12944); no command reopens a
      // decision. Two devices deciding differently resolve by LWW and record
      // the divergent decision as a conflict.
      status: {
        kind: 'absorbing',
        id: 'playbook.approval.once',
        states: ['approved', 'rejected'],
        leaveOps: [],
      },
    },
  },
  brain_sticky_notes: {
    rules: {
      // One-way and order-free (T12942): the status is the maximum of its
      // writes by active < archived < converted, so a sticky never returns to
      // active, and a conversion beats a concurrent archive in every order,
      // keeping status and converted_to_json in agreement (B24). No command
      // reverses either move, so there are no restore ops.
      status: {
        kind: 'rank-max',
        id: 'sticky.status.one-way',
        order: ['active', 'archived', 'converted'],
        restoreOps: [],
      },
      // A second conversion to another target is refused, never LWW (SK2).
      converted_to_json: { kind: 'write-once', id: 'sticky.status.one-way' },
    },
  },
  docs_attachments: {
    // A supersession writes the status and its successor together (D04).
    groups: [['lifecycle_status', 'superseded_by']],
    rules: {
      // superseded is sticky (T12945): no command leaves it — the local docs
      // domain refuses a status change or content edit of a superseded doc,
      // so origin and receivers agree. Other statuses merge by LWW.
      lifecycle_status: {
        kind: 'absorbing',
        id: 'docs.lifecycle.transitions',
        states: ['superseded'],
        leaveOps: [],
      },
    },
  },
  decision_adr_links: {
    // The revoke and its author move together, taken from the winning op.
    groups: [['status', 'revoked_by']],
    rules: {
      // 'revoked' is absorbing with NO leave op (T13597): a concurrent
      // same-uid link op from another device merges field by field and its
      // status='linked' write is refused, so a tombstoned pair can never be
      // resurrected by LWW, whatever order the ops arrive in.
      status: {
        kind: 'absorbing',
        id: 'docs.decision-adr-links.revoke-monotonic',
        states: ['revoked'],
        leaveOps: [],
      },
    },
  },
};

/** The rule ids this registry implements, for the write-invariant gate. */
export function implementedMergeRuleIds(): string[] {
  const ids: string[] = [];
  for (const set of Object.values(SYNC_MERGE_RULES)) {
    for (const rule of Object.values(set.rules ?? {})) ids.push(rule.id);
    if (set.immutable !== undefined) ids.push(set.immutable);
  }
  // One invariant may cover several tables (a twin pair) or columns.
  return [...new Set(ids)].sort();
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
