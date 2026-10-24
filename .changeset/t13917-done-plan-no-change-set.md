---
id: t13917-done-plan-no-change-set
tasks: [T13917]
kind: fix
summary: cleo done --plan never takes test or lint targets from the working tree; a no-change-set task is told its doc or decision route
---

`cleo done --plan` for a task with no change set no longer plans test runs,
lint or typecheck, and no longer names test files or roots from a shared
dirty checkout. Before this fix, a record-only task was asked to run 18
unrelated tests and to lint 125 directories. A standalone project's targeted
test-run and qa-run roots now come from the task's change set only.

A research or documentation task with no change set is now told to attach
its document (`cleo docs add`) or link a decision
(`cleo memory decision-store --linked-task`), never to create a branch. A
code task with no change set still gets the branch route, and is also told
the record-or-decision route for work that changed no code.
