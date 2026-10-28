---
id: done-needs-ac-coverage-everywhere
tasks: [T12883]
kind: fix
summary: "Every writer that sets done requires the task's acceptance criteria to be covered (T12883 R2)"
---

Only `cleo complete` checked acceptance-criteria coverage before a task became
done. `tasks.bulk-move` to done, `cleo unarchive --status done`, saga
auto-close (`reconcileSaga`) and the release archive-reason reconcile now
apply the same check (`assertAcCoveredForDone`, refusing with
`E_AC_COVERAGE_INCOMPLETE`; the release reconcile files its follow-up task
instead of stamping done). A done child still covers its parent's "Complete
child" criterion. Imports and snapshot restores keep writing recorded rows
as-is.

Also fixed: `cleo unarchive` refused every archived task as "already exists in
active tasks", because an archived task keeps its row; it now refuses only a
task that is not archived.
