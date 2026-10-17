---
id: tasks-changeset-test-plan
tasks: [T13795]
kind: feat
summary: "cleo tasks changeset <id> [--test-plan] reports a task's change set, commits and the exact test files it owes, as data"
---

`cleo tasks changeset <id>` returns the change set `cleo done` derives,
including the source, files and deleted files, plus the change's commits.

`--test-plan` adds the tests the change owes, judged exactly as enforcement
judges them:
- the exact test files a covering `test-run:` report must run, each with its
  reason;
- the packages it must run at least one test file of;
- the CLEO config files left to `tool:config-schema`;
- the typecheck-only dependents left to a typecheck;
- the testsPassed tool runs and blockers `cleo done --plan` reports.

Blockers carry a new `gate` field, so they are selected by gate rather than by
message text.

Before merge, the plan judges the checkout's diff, as the `test-run:` binding
does. After merge, it judges the task's own part of the landed change, as
`cleo complete` does, and owes every test file that change adds or edits.

The owed tests come from the new `testRunRequirement`, the requirement the
binding judges a report against. `testRunCoversChange` now reads it, with
refusal texts unchanged, so the two cannot drift.
