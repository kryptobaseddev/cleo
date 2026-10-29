---
id: pr-cadence
tasks: [T14143]
kind: feat
summary: "PR cadence spec (small PRs per task group, traceable to release) and a PR Task Lines check that flags a PR naming no task"
---

Owner decision D11212.

- **Spec.** `docs/spec/pr-cadence.md` (store slug `pr-cadence`) defines the
  rule: one PR per task group, small, every PR naming its tasks with
  `Closes:`/`Refs:` lines, and a changeset with the same tasks. It also traces
  the chain from task to commit, PR, review, merge sweep, `cleo release cut`
  and provenance, and covers batching at release time and the release cadence.
- **Check.** The new `PR Task Lines` workflow runs
  `scripts/lint-pr-task-lines.mjs`. It flags a PR whose body names no task, or
  whose task lines are malformed, on open, edit, push and label changes.
  - Exempt: `release/*` branches, bots and the `no-task` label.
  - Its grammar mirrors the merge sweep's `parseMergeDirectives`, and a test
    keeps the two in agreement.
  - It is advisory: listed in the merge-bar gate's `ADVISORY_WORKFLOWS`, it
    flags rather than gates.
- **ct-dev-workflow** 3.3.0 states the rule.
