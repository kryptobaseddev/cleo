---
id: merge-attribution-budget-task
tasks: [T14254]
kind: feat
summary: "a budget-crossed merge attribution names the crossing PR and files one main-over-budget fix task"
---

D11225, finished: the flaky-quarantine budget counts open issues across the
repository, so a quarantine-only failure is `main-health` and never the
merging PR's (#1978 crossed the limit only because the issue tracker did).

A budget tripwire the PR crossed itself (the core bundle size, gate-39 CLI
startup module counts, `gen:sdk` drift; the parent passed it) is
`budget-crossed`, and its reason names the PR. The merge sweep then files one
open `main-over-budget` task per budget, under the epic of the crossing PR's
task: "Main over budget: <budget> (crossed by PR #N)". A budget that already
has an open task gets no second one; a PR naming no task under an epic files
none and the receipt says why (`budgetTaskSkipped`). The receipt lists the
tasks in `budgetTasks`. The PR's own task is untouched and closes as it would
(shadow mode, D11224).
