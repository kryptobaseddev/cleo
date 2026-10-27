---
id: node-test-tap-counts
tasks: [T14051, T14060]
kind: fix
summary: "Typed test gates count node:test TAP runs and name why a found report was refused"
---

A `minCount` test gate on `node --test` or `tsx --test` could never be
counted: node:test ships no JSON reporter, and the gate accepted only a
Vitest/Jest JSON report or a bare summary line. With `--test-reporter=tap` the
run's own stdout is now counted from its last top-level `1..N` plan and the
`# tests`, `# pass` and `# fail` summary after it (`# cancelled` counts as
failed). A run with zero tests, a `Bail out!` or no summary is refused, never
counted as passing. The remediation names `--test-reporter=tap` for node:test
commands instead of `--reporter=json`, which node:test rejects (T14051).

A report that parsed but failed schema validation used to be dropped silently,
so the error said no machine-readable report existed. The refusal now names
the candidate (the last stdout line, a JSON report in the output, or the
report file path) and its first failing field, and the remediation lists the
accepted shapes, including the minimal `{"numPassedTests":N}` summary line
(T14060).
