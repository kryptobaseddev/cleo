---
id: typed-gate-structured-verdict
tasks: [T13752, T13753, T13754]
kind: fix
summary: "Typed test gates take their verdict from structured counts, minCount reads a wrapper's last-line count JSON, and a change outside every workspace package can pass testsPassed with a targeted run"
---

**T13752.** A passing typed test gate (`expect: pass`) failed with "Failure
pattern detected in output" when a test name contained a word like "failure"
or "failing". When the run prints a structured report (vitest/jest JSON, or a
count summary), the verdict now comes from its counts. The text heuristic runs
only when there is no report, and it skips passing-test lines (`✓`, `✔`, `√`,
TAP `ok N`, `PASS`).

`cleo done --plan` showed "Typed gate last failed" after a passing
`cleo verify --run`. The stored result was an `error`: a later cache-only write
found no cached pass. An `error` is not a verdict, so it now shows as not run.

**T13753.** A typed gate with `minCount` and a wrapper command, such as a
`python3 -c` script, reported "minCount cannot be proved" with
`exitCode: null` and no output. The command did run, but two things went
wrong. Only a full vitest report was accepted, and the error threw away the
run record. The gate now also reads a count summary on the last stdout line,
e.g. `{"numPassedTests":13,"numFailedTests":0}`, and the error keeps the
real exit code and output.

**T13754.** A change that touched paths outside every pnpm package (for
example `tooling/print-bridge/*`) counted as workspace-wide, so only a
whole-suite run could satisfy it. Such a path now belongs to the nearest
directory above it that holds test files outside every package. A `test-run:`
report, or the post-merge stand-in, must pass every one of those test files,
plus the usual per-package coverage. `tool:test-affected` runs them directly
with `node --test`, or through a `{projects}` vitest template. Repo-root files
and directories with no test file still count as workspace-wide.
