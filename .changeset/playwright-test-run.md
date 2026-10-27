---
id: playwright-test-run
tasks: [T14031]
kind: fix
summary: "test-run evidence reads Playwright JSON reports, and the reports of one write cover a change together"
---

A change that adds an e2e spec could never prove `testsPassed` with a
`test-run:` report: only vitest/jest JSON (`testResults[]`) was read, so a
Playwright report covered no test file. A Playwright `--reporter=json` report
is now adapted before the counter and binding checks: the files run come from
`suites[].file` (resolved against `config.rootDir`), the counts from the spec
results (`expected` and `flaky` pass, `unexpected` fails, `skipped` is
pending, and they must equal `stats`), and the run time from
`stats.startTime`. A report with top-level `errors` (no tests found), a
failing, skipped-only or vacuous run is refused like a vitest one.

The `test-run:` atoms of one evidence write are now judged together for
coverage, so `test-run:vitest.json;test-run:playwright.json` covers a change's
unit and e2e test files between them. Each report is still validated on its
own and records only its own files.
