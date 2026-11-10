---
id: review-dispatch
tasks: [T14372]
kind: feat
summary: "cleo review dispatch sends one shadow reviewer per routine PR head that lacks verdicts, under a session it creates; lead-reserved PRs stay with the lead, and counted reviewers wait for the owner's review.workers.counted"
---

Verdicts were recorded by hand by the lead, and the lead keeps reviewing every
PR until reviewer workers prove themselves in shadow mode.

- `cleo review dispatch` (dry run by default; `--execute` records) reads every
  open PR. For each routine PR whose head lacks verdicts it creates the
  reviewer's own session (agent id `reviewer-<mode>-pr<n>-<sha7>`), records one
  `review.dispatch` audit row per task with the PR number, head sha and that
  session, and prints the brief: that identity only, `cleo review packet`, one
  verdict per criterion, a task per serious finding, a closing
  `findings: T####,... | none` line, never an edit to the PR. The same head is
  never dispatched twice; a new head is, up to 3 heads per PR.
- Shadow by default: the reviewer records `cleo review verdict --shadow`,
  stored as `review.shadow-verdict` and never counted. `cleo review check`
  lists each criterion's shadow verdict next to the lead's (verdicts from
  worker sessions are never the lead's). `--counted` is refused unless the
  owner sets the new config key `review.workers.counted` (default false).
- Lead-reserved, never dispatched: migrations, store or sync code, gates
  (`scripts/lint-*`, `scripts/check-*`, workflows), evidence code, review,
  session and claim code, `CLEO-INJECTION.md`, `AGENTS.md`,
  `.cleo/project-context.json`, and deletions; a rename is judged by both
  paths. Routing reads GitHub's JSON file list, and an unknown status, an
  unreadable path or a list shorter than the PR's file count also reserves.
- `cleo review verdict` now refuses a worker verdict (a `reviewer-*` agent id,
  a dispatched session, or `--shadow`) unless one dispatch on that head names
  both its agent id and session, in the same mode; the non-author refusal is
  unchanged. The dispatcher may not be an author of the task.
