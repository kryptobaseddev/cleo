---
id: req-move
tasks: [T14200]
kind: feat
summary: "cleo req move gives an acceptance criterion to another task as its next AC, keeping its uid and history, audited on both tasks"
---

A criterion that belongs to another lane's task could only be waived or
removed under the acceptance-lock override (owner override audit, class C).

`cleo req move <task> AC<n> --to <task>` moves it: the target gains it as
its next `AC<n>`, the criterion keeps its uid and birth fingerprint (the
identity its history joins on), the source writes an AC history row with
reason `move` instead of a removal, and the acceptance lock audits the
source as `change: 'move'` (moved, not weakened, so no `--reason`) and the
target as an append. An `ac_moved` audit row on each task names the
criterion, both tasks and the actor. A done, cancelled or archived task on
either side, a criterion with recorded evidence bindings, a child-task
projection and a criterion the target already has are refused.
