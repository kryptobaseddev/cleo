---
id: t13136-test-run-counter-shapes
tasks: [T13136]
kind: fix
summary: test-run evidence accepts summary and node --test counters, and a report without counts names the keys it needs
---

`test-run:<report.json>` read only vitest/jest counters (`numTotalTests`, `numPassedTests`,
`numFailedTests`, `numPendingTests`, `numTodoTests`). A report with `{total, passed, failed,
skipped}` was refused as "zero total tests" without saying which keys were read (gh#1804). It now
reads the first counter set the report carries:

- vitest `--reporter=json` / jest `--json`: `numTotalTests`, `numPassedTests`, `numFailedTests`,
  `numPendingTests` + `numTodoTests`;
- a runner's summary output (bun test, tsx --test): `total`, `passed`, `failed`, `skipped` +
  `todo`;
- a node --test summary: `tests`, `pass`, `fail` + `cancelled`, `skipped` + `todo`.

Every count must be a non-negative integer, and passed + failed + skipped/todo must equal the total.
A failure under any key (`numFailedTests`, `failed`, `fail`, `cancelled`, `failures`, `errors`)
refuses, whichever set supplied the total. `exit` / `exitCode` must be a number, and a non-zero one
is refused. A report with no counter set, with counts that are not integers or do not add up, or
with a `testResults` that is not an array of objects, is refused with `E_EVIDENCE_INVALID`, and the
message names the keys or the arithmetic. A zero total names the key it read. `cleo verify --help`
documents all of this. A `test-run:` atom proves only what its file says; `tool:test` and `ci:<pr>`
prove the run.

Only a vitest/jest report lists the test files it ran. In a workspace, a targeted report must still
cover every affected package that has tests, so a summary report is refused there, and
`tool:test-affected` or `tool:test` is the evidence to record.
