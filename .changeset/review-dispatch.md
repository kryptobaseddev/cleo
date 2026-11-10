---
id: review-dispatch
tasks: [T14372]
kind: feat
summary: "cleo review dispatch sends one non-author reviewer per routine PR head that lacks verdicts; lead-reserved PRs stay with the lead, and shadow mode records verdicts that never count"
---

Verdicts were recorded by hand by the lead. `cleo review dispatch` (dry run by
default; `--execute` records) reads every open PR and, for each routine PR
whose head lacks per-AC verdicts, records one `review.dispatch` audit row per
task with the PR number and head sha, and prints the brief to hand the
reviewer agent: its own session and agent id, `cleo review packet` only, one
`cleo review verdict` per criterion, a task per serious finding, never an
edit to the PR. The same head is never dispatched twice; a new head is.

- A PR touching a migration, store or sync code, a gate (`scripts/lint-*`,
  `scripts/check-*`, workflows), evidence code, or deleting a file is
  lead-reserved and never dispatched.
- The existing non-author refusal of `cleo review verdict` is unchanged and
  applies to every dispatched reviewer.
- `--shadow` sends reviewers to record `cleo review verdict --shadow`, stored
  as `review.shadow-verdict` with every independence check and never counted
  toward a merge; `cleo review check` lists each criterion's shadow verdict
  next to the counted one and whether they agree.
