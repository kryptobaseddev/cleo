---
id: t13145-flaky-quarantine
tasks: [T13145]
kind: chore
summary: CI re-runs a failing test's file once; a flake is filed and quarantined instead of blocking
---

Each unit shard now runs vitest through `scripts/ci-flaky-quarantine.mjs`. A failing test's file
is re-run once. If the test then passes, it is a flake: CI stays green, the test is reported in the
run summary and in a `flaky-report-*` artifact, and on main it is filed as an open `flaky-quarantine`
issue (only issues GitHub Actions files count). While that issue is open, a failure of the test that
also fails its re-run does not block CI, and it does not renew the quarantine.

The nightly run closes an issue that has had no confirmed flake for 14 days, so a test that is broken
rather than flaky leaves quarantine and blocks again. Main's CI fails while more than 10 tests are
quarantined; pull requests only warn. Still blocking:
- a test that fails twice outside quarantine;
- more than 10 failing files;
- an error outside any test (vitest's `Unhandled Errors`), even next to a flake;
- a crash or heap kill with no attributable test;
- an unreadable quarantine.

The merge-queue runbook documents the flow.
