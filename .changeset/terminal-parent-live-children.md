---
id: terminal-parent-live-children
tasks: [T12883]
kind: fix
summary: "No writer leaves a terminal parent over live children (T12883 R1)"
---

`cleo complete` refused a parent with live children only for epics; it now
refuses any parent (a task with live subtasks, a saga with live members), with
the same audited `--override-reason`. Moving a task under a cancelled or
archived parent (`cleo update --parent`, reparent) is refused, as `cleo add`
already refused new work there. `tasks.bulk-move` to done, cancelled or
archived refuses a task with live children. Restoring or unarchiving a task
under a still-cancelled parent is refused; restore the parent with `--cascade`.
Also fixed: `cleo unarchive` validated the requested status but never wrote it.
