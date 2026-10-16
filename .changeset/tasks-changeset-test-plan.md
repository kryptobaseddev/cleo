---
id: tasks-changeset-test-plan
tasks: [T13795]
kind: feat
summary: "cleo tasks changeset <id> [--test-plan] reports a task's change set, commits and the exact test files it owes, as data"
---

`cleo tasks changeset <id>` returns the change set `cleo done` derives,
including the source, files and deleted files, plus the change's commits.

`--test-plan` adds the tests the change owes:
- the exact test files a covering `test-run:` report must run, each with its
  reason;
- the packages it must run at least one test file of;
- the testsPassed tool runs and blockers `cleo done --plan` reports.

The owed tests come from the new `testRunRequirement`, the same requirement the
`test-run:` binding judges a report against: `testRunCoversChange` now reads
it, with refusal texts unchanged. The two cannot drift.
