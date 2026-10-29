---
id: doctor-type-matrix-repair
tasks: [T14096]
kind: feat
summary: "cleo doctor type-matrix plans, applies with a receipt, and rolls back the repair of parent/child type-matrix violations (T14096)"
---

`cleo doctor --coherence` reports parent/child pairs that break the type matrix
(saga to epic, epic to task, task to subtask), and new writes are refused
(T12883 R4). Rows written earlier needed a repair that is not a hand edit.

`cleo doctor type-matrix` is a dry run by default. It lists every violation
with the one re-type that fixes it, or, when there is more than one way (or
none), the options for the calling agent to choose from with
`--resolutions <file>`. `--apply` re-types or re-parents through the task
accessor in one transaction, refusing any row that changed since it was read,
and writes a receipt to the task audit log. A re-parent is checked as
`cleo update --parent` checks one (no cancelled or archived parent, no cycle,
depth and sibling limits) and reopens done ancestors. `--rollback <receipt>` restores
the rows the type-matrix trigger allows and names each row it refuses, with
the reason (for example a legacy task under a task). It refuses a row edited
after the repair, and never restores one in a way that breaks a child filed
under it since.

Behaviour change: the contracts matrix is the authority, so a subtask directly
under an epic counts as a violation and is re-typed to a task, although the
database trigger still accepts that pair until T14131 tightens it.
