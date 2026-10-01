/**
 * Sync write-invariant registry (T12881): every rule TypeScript enforces on a
 * write to a synced table, with the class that says how it survives merged
 * apply (spec `t12859-sync-write-validator-inventory` §3.6.7, journal design
 * §3.6).
 *
 * The raw applier never runs the TypeScript write paths, so a rejection site
 * on a synced write path carries `// @sync-invariant <id>` naming an entry
 * here, or an escape tag (`none:input-shape <reason>`,
 * `none:local-only <reason>`). Gate 38 (`scripts/lint-sync-write-invariants.mjs`)
 * finds the sites with the TypeScript compiler API and fails on an untagged
 * one that is not in its shrink-only baseline, on a dangling tag, and on a
 * registry entry that does not close (§3.6.7 rule 5).
 *
 * Seeded from the inventory's distinct catalogues: the trigger and index
 * guards of §3.6.2, the fifteen post-apply check families PAC-01..PAC-15 of
 * §3.6.5 and the typed merge rules of §3.6.6. The executable post-apply
 * checks and the merge-rule registry belong to the merge engine (T12344) and
 * do not exist yet, so each PAC and each rule carries `pending` naming its
 * own open T12344 item (T12922..T12936 for PAC-01..15, T12937..T12945 for the
 * rules); `--verify-tasks` checks those tasks are open. Trigger-covered
 * entries carry no pending: their triggers and indexes are checked against
 * migrations and fresh stores. The §3.5 Rule 4 guard-class footprint check is
 * not enforced until that class exists.
 *
 * Types and const data only (arch gate 10).
 *
 * @task T12881
 * @epic T12323
 */

/**
 * How a write rule survives merged apply (§3.6 intro).
 *
 * - `trigger-covered` — a migration-created trigger, CHECK, UNIQUE or FK
 *   enforces the same rule on apply.
 * - `post-apply-check` — a multi-row or cross-table rule evaluated over the
 *   apply page's footprint (a T12344 PAC item).
 * - `monotonic-merge-rule` — a per-row or per-field transition or grouping
 *   rule, enforced by a T12344 typed merge rule.
 * - `not-sync-relevant` — input shape, local-only data or a single-column
 *   value rule LWW cannot break.
 * - `identity-layer` — really about id minting; T12341 uids and re-minting
 *   own it.
 *
 * @task T12881
 */
export type SyncWriteInvariantClass =
  | 'trigger-covered'
  | 'post-apply-check'
  | 'monotonic-merge-rule'
  | 'not-sync-relevant'
  | 'identity-layer';

/**
 * A closure requirement the entry cannot meet yet, and the task that meets it.
 *
 * @task T12881
 */
export interface SyncWriteInvariantPending {
  /** The task that lands the missing piece (e.g. the T12344 check or rule). */
  readonly task: string;
  /** What is missing. */
  readonly reason: string;
}

/**
 * One distinct write rule on synced tables.
 *
 * @task T12881
 */
export interface SyncWriteInvariant {
  /** Stable id named by `@sync-invariant <id>` tags, e.g. `task.status.absorbing`. */
  readonly id: string;
  /** How the rule survives merged apply. */
  readonly class: SyncWriteInvariantClass;
  /** Physical tables; each must be classified by Gate A. */
  readonly tables: readonly string[];
  /** Known rejection sites (repo-relative file, enclosing symbol, codes). */
  readonly sites: readonly {
    readonly file: string;
    readonly symbol: string;
    readonly codes: readonly string[];
  }[];
  /** `trigger-covered`: trigger or index names a migration creates. */
  readonly triggers?: readonly string[];
  /**
   * `post-apply-check`: the check and its footprint. `module` and
   * `functionName` may be absent only while `pending` is set.
   */
  readonly check?: {
    readonly module?: string;
    readonly functionName?: string;
    readonly footprint: readonly string[];
  };
  /** `monotonic-merge-rule`: the table and columns the rule merges (`*` = whole row). */
  readonly mergeRule?: { readonly table: string; readonly columns: readonly string[] };
  /** A runtime guard enforcing the rule; it must have a production caller. */
  readonly runtimeGate?: { readonly module: string; readonly functionName: string };
  /** Convergence sources the rule reads (config, file, env, local-only column). */
  readonly readsNonSynced?: readonly string[];
  /** Set when every replica is pinned to the same `readsNonSynced` policy (§3.5 Rule 1). */
  readonly pinnedPolicy?: boolean;
  /** Inventory rows behind the entry (PAC item, V/C/S/B/D/… row ids). */
  readonly inventory?: readonly string[];
  /** A closure requirement not met yet. */
  readonly pending?: SyncWriteInvariantPending;
  /** Why; required for `not-sync-relevant` and `identity-layer`. */
  readonly reason: string;
}

/** A post-apply check not implemented yet; `task` is its T12344 item. */
function checkPending(task: string): SyncWriteInvariantPending {
  return { task, reason: 'the post-apply check is not implemented yet (T12344 item)' };
}

/** A merge rule the merge-rule registry does not define yet; `task` is its T12344 item. */
function rulePending(task: string): SyncWriteInvariantPending {
  return { task, reason: 'the typed merge-rule registry does not define it yet (T12344 item)' };
}

function trigger(
  id: string,
  tables: readonly string[],
  triggers: readonly string[],
  inventory: readonly string[],
  reason: string,
): SyncWriteInvariant {
  return { id, class: 'trigger-covered', tables, sites: [], triggers, inventory, reason };
}

function pac(
  id: string,
  item: string,
  task: string,
  tables: readonly string[],
  footprint: readonly string[],
  reason: string,
): SyncWriteInvariant {
  return {
    id,
    class: 'post-apply-check',
    tables,
    sites: [],
    check: { footprint },
    inventory: [item],
    pending: checkPending(task),
    reason,
  };
}

function rule(
  id: string,
  task: string,
  table: string,
  columns: readonly string[],
  inventory: readonly string[],
  reason: string,
  tables: readonly string[] = [table],
): SyncWriteInvariant {
  return {
    id,
    class: 'monotonic-merge-rule',
    tables,
    sites: [],
    mergeRule: { table, columns },
    inventory,
    pending: rulePending(task),
    reason,
  };
}

/**
 * The sync write-invariant registry, in inventory order.
 *
 * @task T12881
 */
export const SYNC_WRITE_INVARIANTS: readonly SyncWriteInvariant[] = Object.freeze([
  // §3.6.2: RAISE guards and UNIQUE indexes a migration creates on synced tables.
  trigger(
    'task.parent.no-cycle',
    ['tasks_tasks'],
    ['tasks_tasks_parent_cycle_guard_insert', 'tasks_tasks_parent_cycle_guard_update'],
    ['V10', 'V11'],
    'the parent chain is acyclic (the INSERT variant misses a self-parent, §3.6.3 item 2)',
  ),
  trigger(
    'task.parent.type-matrix',
    ['tasks_tasks'],
    ['tasks_tasks_parent_type_matrix_insert', 'tasks_tasks_parent_type_matrix_update'],
    ['X1'],
    'parent/child type matrix; weaker than TypeScript (§3.6.3 item 1), the rest is PAC-01',
  ),
  trigger(
    'task.status.pipeline-consistency',
    ['tasks_tasks'],
    ['trg_tasks_tasks_status_pipeline_insert', 'trg_tasks_tasks_status_pipeline_update'],
    ['V19', 'C21'],
    'T877: status and pipeline_stage agree on one row',
  ),
  trigger(
    'task.relation.non-containment',
    ['tasks_task_relations'],
    ['tasks_task_relations_non_containment_insert', 'tasks_task_relations_non_containment_update'],
    ['V31'],
    'no relation between a parent and its child, on relation writes only (§3.6.3 item 4)',
  ),
  trigger(
    'task.ac.child-target',
    ['tasks_task_acceptance_criteria'],
    ['tasks_task_acceptance_child_target_insert', 'tasks_task_acceptance_child_target_update'],
    ['C28'],
    'a child_task AC targets a direct child, on AC writes only (§3.6.3 item 4)',
  ),
  trigger(
    'session.handoff.append-only',
    ['tasks_session_handoff_entries'],
    ['trg_tasks_session_handoff_no_update'],
    ['H2'],
    'handoff entries are never updated',
  ),
  trigger(
    'task.claim.lease-iso',
    ['tasks_tasks'],
    ['tasks_tasks_lease_iso_insert', 'tasks_tasks_lease_iso_update'],
    [],
    'claim lease timestamps are ISO-8601 (t12736)',
  ),
  trigger(
    'task.ac-binding.unique',
    ['tasks_evidence_ac_bindings'],
    ['uq_tasks_evidence_ac_bindings_atom_ac_type'],
    ['C31'],
    'one binding per (evidence atom, AC, binding type)',
  ),
  trigger(
    'release.version.unique',
    ['tasks_releases'],
    ['uq_tasks_releases_version'],
    ['REL-1'],
    'one release row per version',
  ),
  trigger(
    'selfimprove.dhq.one-open',
    ['selfimprove_dhq'],
    ['ux_selfimprove_dhq_open'],
    ['D49'],
    'at most one open DHQ entry per question_hash',
  ),
  trigger(
    'account.one-active-per-provider',
    ['accounts'],
    ['ux_accounts_active_provider'],
    ['A40'],
    'at most one active account per provider (partial UNIQUE)',
  ),

  // §3.6.5: post-apply check families (T12344 items).
  pac(
    'task.tree.shape',
    'PAC-01',
    'T12922',
    ['tasks_tasks'],
    ['rows with a changed parent_id or type', 'their direct children and ancestor chain'],
    'saga→epic→task→subtask matrix, non-saga has a parent, depth ≤ 3, no self-parent',
  ),
  pac(
    'task.terminal-parent.live-children',
    'PAC-02',
    'T12923',
    ['tasks_tasks'],
    ['rows whose status, stage or parent changed', 'their parent and siblings'],
    'no terminal parent with a live child; epic stage ≥ children; rollup re-evaluated',
  ),
  pac(
    'task.dependency.graph',
    'PAC-03',
    'T12924',
    ['tasks_task_dependencies', 'tasks_tasks'],
    ['dependency edges inserted in the page', 'reachability from each depends_on'],
    'dependencies are acyclic, with no self-edge',
  ),
  pac(
    'task.done.evidence',
    'PAC-04',
    'T12925',
    ['tasks_tasks', 'tasks_task_acceptance_criteria', 'tasks_evidence_ac_bindings'],
    ['done rows in the page', 'their AC rows, bindings, acceptance_json and verification_json'],
    'a done task has passed verification and every AC bound or waived',
  ),
  pac(
    'task.ac.integrity',
    'PAC-05',
    'T12926',
    ['tasks_tasks', 'tasks_task_acceptance_criteria', 'tasks_evidence_ac_bindings'],
    ['tasks whose AC rows, bindings, acceptance_json, parent_id or relations changed'],
    'acceptance_json ⇔ AC rows, child_task ACs match children, bindings resolve',
  ),
  pac(
    'lifecycle.rows',
    'PAC-06',
    'T12927',
    ['tasks_lifecycle_pipelines', 'tasks_lifecycle_stages', 'tasks_tasks'],
    ['lifecycle pipeline, stage and gate rows in the page', 'the owning task row'],
    'one pipeline per task, one stage row per name, pipeline_stage ≥ completed stages',
  ),
  pac(
    'derived.mirrors',
    'PAC-07',
    'T12928',
    ['tasks_task_labels', 'brain_sticky_tags', 'docs_wikilinks', 'tasks_tasks'],
    ['owning rows whose JSON or junction changed'],
    'junction tables equal their JSON source',
  ),
  pac(
    'session.goal.singletons',
    'PAC-08',
    'T12929',
    ['tasks_sessions', 'tasks_task_work_history', 'tasks_goal'],
    ['session rows whose status, scope or chain changed', 'work-history rows per session'],
    'one active session per scope, reciprocal chain, one open interval, one live goal',
  ),
  pac(
    'audit.uniqueness',
    'PAC-09',
    'T12930',
    ['tasks_audit_log'],
    ['audit rows with a non-null idempotency key', 'rollback audit rows'],
    'idempotency keys are unique across replicas; at most one rollback per receipt',
  ),
  pac(
    'identity.collisions',
    'PAC-10',
    'T12931',
    ['tasks_tasks', 'tasks_sessions', 'brain_observations', 'docs_attachments'],
    ['inserted rows', "the natural key's index"],
    'display-id and natural-key clashes become an alias or re-mint (T12341)',
  ),
  pac(
    'dedupe.at-most-one',
    'PAC-11',
    'T12932',
    ['brain_decisions', 'brain_learnings', 'tasks_external_task_links'],
    ['inserted rows grouped by the natural key'],
    'duplicates created on two devices are merged',
  ),
  pac(
    'ref.soft-orphans',
    'PAC-12',
    'T12933',
    ['brain_memory_links', 'brain_page_edges', 'docs_attachment_refs', 'tasks_task_commits'],
    ['reference columns of the rows in the page', 'their targets'],
    'cross-DB and polymorphic references resolve',
  ),
  pac(
    'supersession.graph',
    'PAC-13',
    'T12934',
    ['brain_decisions', 'docs_attachments', 'tasks_architecture_decisions'],
    ['rows whose supersession columns changed', 'a chain walk'],
    'supersession chains are acyclic with at most one successor',
  ),
  pac(
    'derived.counters',
    'PAC-14',
    'T12935',
    ['docs_attachments', 'conduit_attachments', 'docs_pipeline_manifest'],
    ['the owning rows'],
    'derived counters and cross-column facts agree with their rows',
  ),
  pac(
    'apply.preconditions',
    'PAC-15',
    'T12936',
    ['tasks_tasks'],
    ['the whole page'],
    'no apply while the local twin collapse has failed; restore is a re-baseline',
  ),

  // §3.6.6: typed merge rules (T12344).
  rule(
    'task.status.absorbing',
    'T12937',
    'tasks_tasks',
    ['status', 'completed_at', 'cancelled_at', 'cancellation_reason', 'pipeline_stage'],
    ['V18', 'V20', 'C22', 'P40', 'P46', 'P47'],
    'done, cancelled and archived are absorbing; leaving them needs an explicit op',
  ),
  rule(
    'task.pipeline-stage.max',
    'T12938',
    'tasks_tasks',
    ['pipeline_stage'],
    ['V21', 'C20', 'P01', 'F3'],
    'pipeline_stage is the maximum by STAGE_ORDER, except an explicit restore',
  ),
  rule(
    'task.verification.frozen-on-done',
    'T12939',
    'tasks_tasks',
    ['verification_json'],
    ['C01', 'C02', 'C03', 'C17'],
    'verification is frozen once done; otherwise merged per gate',
  ),
  rule(
    'session.status.terminal',
    'T12940',
    'tasks_sessions',
    ['status', 'ended_at'],
    ['S7', 'S8', 'S9', 'S10', 'S11', 'S17', 'S18', 'SC2', 'N1', 'SK5', 'P32'],
    'ended and orphaned are terminal except on an explicit resume',
  ),
  rule('audit.immutable', 'T12941', 'tasks_audit_log', ['*'], ['SA3'], 'audit rows are immutable', [
    'tasks_audit_log',
    'audit_log',
  ]),
  rule(
    'sticky.status.one-way',
    'T12942',
    'brain_sticky_notes',
    ['status', 'converted_to_json'],
    ['SK2', 'SK3', 'B24'],
    'active→{converted, archived} is one-way; converted_to_json is write-once',
  ),
  rule(
    'release.status.absorbing',
    'T12943',
    'tasks_releases',
    ['status'],
    ['REL-2', 'REL-3', 'REL-4', 'REL-5', 'REL-6', 'REL-7', 'REL-8'],
    'shipped release statuses are absorbing',
  ),
  rule(
    'playbook.approval.once',
    'T12944',
    'tasks_playbook_approvals',
    ['status'],
    ['PB-1', 'PB-4', 'PB-7', 'P33'],
    'an approval goes pending→decided once',
  ),
  rule(
    'docs.lifecycle.transitions',
    'T12945',
    'docs_attachments',
    ['lifecycle_status'],
    ['D04', 'D05', 'D31', 'D32', 'D39', 'D50'],
    'superseded is sticky; lifecycle transitions follow a matrix',
  ),

  // §3.6.0 identity-layer rows.
  {
    id: 'identity.local-minting',
    class: 'identity-layer',
    tables: ['tasks_tasks', 'tasks_sessions'],
    sites: [],
    inventory: ['V12', 'B07', 'B12'],
    reason:
      'ids minted from local state (display ids, integer PKs, device-derived ids) collide across replicas; T12341 uids and re-minting own it, no validator port can',
  },
]);
