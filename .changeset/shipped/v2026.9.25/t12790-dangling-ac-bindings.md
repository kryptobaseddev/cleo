---
id: t12790-dangling-ac-bindings
tasks: [T12790]
kind: fix
summary: Evidence bindings leave the store with their acceptance criterion; `cleo doctor ac-bindings` reports and repairs the ones left behind
---

The consolidated project schema declares no foreign key from
`tasks_evidence_ac_bindings.ac_id` to `tasks_task_acceptance_criteria`. The
legacy table's `ON DELETE CASCADE` did not survive consolidation. So every AC
removed by an edit, and every AC that went with a hard-deleted task, left its
evidence bindings behind with nothing pointing at them.

The task accessor now deletes those bindings in the same transaction that
removes the AC rows. This covers `deleteAcRowsByIds` (the AC diff path behind
`applyAcPlan`), `deleteAcRowsForTask`, `removeSingleTask` (both the accessor
and the transaction version) and the legacy `deleteTask`. No schema migration
is needed. Bindings of ACs that survive an edit are not touched, and the prune
only removes bindings of AC ids that the task actually owns.

The rows are not simply dropped. One reader depends on historical bindings:
alias-drift detection (`E_AC_ALIAS_DRIFTED`, ADR-079-r2 §3) uses a
`satisfies` binding to know what `AC<n>` used to mean. Before a binding is
deleted, its full row is written to `tasks_audit_log` as
`ac.bindings.pruned`, keyed by the task that owned the AC. The drift detector
reads those rows as well as the live table, so removing an AC does not turn a
drifted alias into a silent rebind.

`cleo doctor ac-bindings` finds bindings whose AC is already gone. It is
read-only by default: it reports exact counts by type and the missing AC ids,
and exits 1 while orphans remain. `--fix` removes them in one accessor
transaction, with the same audit line (reason `orphan-repair`).

Age-based audit pruning (`auditRetentionDays`) never deletes
`ac.bindings.pruned` rows, in either audit table, so retention cannot
silently disable alias-drift detection.

Reverting an AC's text (A→B→A) restores its id but not its pruned binding:
the task needs a fresh `cleo verify`. Before this change the stale binding
silently counted again.
