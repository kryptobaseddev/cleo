---
id: integration-tests-run-in-ci
tasks: [T14410]
kind: test
summary: "24 excluded integration test files now run in CI, and gate 43 fails when a tracked test file matches no CI run"
---

The vitest configs excluded `*.integration.test.ts` and `*-integration.test.ts`,
and no CI job ran them, so 24 test files never executed. The 21 that need no
network or VM are renamed to `*.int.test.ts` / `*-int.test.ts` and join the unit
run. The 3 live-credential or VM suites (Pi Anthropic turn, Gondolin, Bedrock)
run in a new `Integration Tests (T14410)` CI job through
`packages/core/vitest.integration.config.ts`; each skips when its credential or
host is absent. The empty `@cleocode/cleo` integration config and its
`test:integration` script are removed.

Gate 43 (`scripts/lint-test-files-run.mjs`, in `cleo check arch`) lists the
files every CI vitest config collects with `vitest list --filesOnly` and fails
on a tracked test file none of them collects. Twelve files that already never
ran are baselined with reasons (burn-down T14411).
