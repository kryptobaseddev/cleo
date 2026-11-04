---
id: mergeclose-test-clock
tasks: [T14214]
kind: test
summary: "the merge-sweep page-budget test runs on a clock anchored to its fixture dates, not the wall clock"
---

The test's PRs are dated from 2026-10-28 and its sweeps pass no `--since`,
so the first sweep read back seven days from `Date.now()`. From 2026-11-04
that window began after PR #1000, the one carrying `Closes:`, and the test
failed on every branch. The sweep's clock is now fixed at 2026-10-29.
