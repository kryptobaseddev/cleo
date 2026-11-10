---
id: integration-tests-run-in-ci
tasks: [T14410]
kind: test
summary: "11 never-run integration test files now run in CI, and gate 43 fails when a tracked test file matches no CI run"
---

The vitest configs excluded `*.integration.test.ts` and `*-integration.test.ts`,
and no CI job ran them, so 24 test files never executed. The 11 that need no
network or VM and pass on main are renamed to `*.int.test.ts` / `*-int.test.ts`
and join the unit run; one of them, `project-move-int.test.ts`, imported a
module path that no longer exists and opened the checkout's own store, both
fixed. The 10 that fail on main keep their names and sit in gate 43's baseline,
each with a repair task (T14413-T14421, T14467). The 3 live-credential or VM
suites (Pi Anthropic turn, Gondolin, Bedrock) run in a new
`Integration Tests (T14410)` step of the Post-build Checks CI job through
`packages/core/vitest.integration.config.ts`, which now spreads the memory-safe
defaults; each skips or returns early when its credential or host is absent,
and the step fails when vitest's report lacks a file the gate expects. The
empty `@cleocode/cleo` integration config and its `test:integration` script are
removed.

Gate 43 (`scripts/lint-test-files-run.mjs`, in `cleo check arch`) lists the
files every CI vitest config collects with `vitest list --filesOnly` and fails
on a tracked test file none of them collects, or when no workflow runs a
config with exactly the pinned command. Its baseline is pinned and, on a pull
request, may not gain an entry against the base; a base it cannot read fails
and names the fetch. It proves collection, not that each file executes in
every run. Gate 18 now also checks named `vitest.<name>.config.*` files.
