---
id: t13809-ci-quarantine-budget-standin
tasks: [T13809]
kind: fix
summary: ci evidence treats a merge-commit run red only on the flaky-quarantine budget as no test failure, and looks past later runs red for that reason or cancelled
---

A main run whose open flaky quarantine exceeded its budget fails every unit-test shard right after the first test run, even when every test passed (or every failure was already quarantined, which never blocks). `ci:<pr>` read that as a real failure the PR introduced, so PRs merged during such a stretch could not close their tasks. The resolver now reads the failing jobs' logs: a job red only on the quarantine budget is a non-test failure, the later green main run stands in for it (recorded as `nonTestFailures`), and for a code task those jobs count as having run for the job gate. The search for that run looks past later runs red only on the budget, or cancelled by a concurrency group with no test failing, across up to 20 later commits. Any other failure still refuses, and a commit touching the PR's files or a CI definition still ends the search.
