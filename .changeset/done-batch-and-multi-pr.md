---
id: done-batch-and-multi-pr
tasks: [T12628]
kind: feat
summary: "`cleo done T1 T2 T3 [--pr N]` closes several tasks shipped by one PR in one call; a task shipped across several of its own PRs records one implemented attempt per PR (D11151)"
---
- **Batch close.** `recordTasksDone` plans and records each task on its own.
  Every task shares one memoised tool runner, so test, lint and typecheck run
  once per execution root for the whole batch. Each task still gets its own
  validated write and its own `tasks.complete`.
- **Blocked tasks.** One task's blocker never stops the others. If any task is
  not completed, the result is `E_DONE_PARTIAL`, with one entry per task in
  `details.results`.
- **Plans.** `--plan` with several ids returns one plan per task.
- **ADR-059.** Shared evidence is never pre-acknowledged, so the existing
  warning fires as before.
- **Multi-PR tasks (D11151).** When a task has several merged PRs from its own
  branches (`task/<id>` or `task/<id>-…`), the latest PR is the primary
  change set. Every earlier one is recorded first as its own `implemented`
  attempt through the same validators (`additionalPrs`, `additionalImplemented`).
- **Other candidates.** Integration PRs that only mention the id are dropped
  whenever at least one own-branch PR exists. With no own-branch PR, several
  candidates are still ambiguous.
- **Checkout check.** The tool tree must contain every one of those PRs' merge
  commits.
