---
id: t13511-node-test-fail-zero
tasks: [T13511]
kind: fix
summary: "a typed test gate with expect pass no longer fails a passing node --test run on its own fail 0 summary line"
---

A typed test gate with `expect: "pass"` checks the output for `FAIL`,
`failing` or `Error:`, case-insensitively. A passing `node --test` run prints
`ℹ fail 0`, and TAP prints `# fail 0`, so every passing node:test gate failed
with "Failure pattern detected in output". Summaries that report zero failures
(`fail 0`, `0 failed`, `0 failing`, `failures: 0`) are now removed before the
pattern runs. A non-zero count, a `FAIL` line, `failing` or `Error:` still
fails the gate. Covered for node:test, TAP, vitest, jest and mocha output.
