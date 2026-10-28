---
id: shared-test-report-counts
tasks: [T14124]
kind: fix
summary: "typed test gates' minCount and test-run evidence read reports through one shared count reader, so every format test-run accepts also counts for a gate"
---

A typed gate's `minCount` refused a node:test event report (VidaPeps
T2373: node-style `tests`/`pass`/`fail` counters plus per-file
`testResults`, no `numTotalTests`) that `test-run:` reads, and `test-run:` read JUnit, libtest and Playwright through adapters the gate
never saw. Both now use `readTestReport` in
`packages/core/src/tasks/test-report-counts.ts`. It reads:

- vitest/jest JSON
- runner summary JSON
- node --test JSON (`tests`/`pass`/`fail`, with or without per-file results)
- Playwright JSON
- JUnit XML
- libtest JSON lines
- node:test TAP

Each format gets the same counts on both paths. When a gate's `minCount`
cannot be proved, the refusal lists every format it tried.

A report whose counters contradict its own per-test results is no longer
evidence: a new `test-run:` recording refuses it, and so does a typed gate.
A new `test-run:` recording of a vitest/jest JSON report now needs all five
test counters (`numTotalTests`, `numPassedTests`, `numFailedTests`,
`numPendingTests`, `numTodoTests`), which real vitest and jest reporters
always emit. The refusal names the missing one.
Receipts already stored are not judged again. `cleo complete` still checks
them by content hash, as before.
