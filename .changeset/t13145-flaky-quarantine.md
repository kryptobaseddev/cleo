---
id: t13145-flaky-quarantine
tasks: [T13145]
kind: chore
summary: CI re-runs a failing test's file once; a flake is filed and quarantined instead of blocking
---

Each unit shard now runs vitest through `scripts/ci-flaky-quarantine.mjs`. A failing test's file
is re-run once. If the test then passes, it is a flake: CI stays green, the test is reported in the
run summary and in a `flaky-report-*` artifact, and on main it is filed as an open `flaky-quarantine`
issue. While that issue is open, the test's failures do not block CI.

The nightly run closes an issue with no new observation for 14 days, so the test leaves quarantine.
CI fails while more than 10 tests are quarantined. A test that fails twice, a crash or heap kill with
no attributable test, and an unreadable quarantine all still block. The merge-queue runbook
documents the flow.
