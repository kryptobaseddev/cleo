---
id: t13203-tool-runner-test-guard
tasks: [T13203]
kind: fix
summary: the evidence tool runner refuses to start a tool from inside a test runner
---

`runToolCached` (behind `tool:test`, `tool:build`, `tool:lint` and `tool:typecheck` evidence) now
refuses to spawn a tool when it runs inside a test runner, unless the test injected a process
runner.

- **Detection**: a process counts as inside a test runner when `VITEST`, `VITEST_WORKER_ID` or
  `JEST_WORKER_ID` is set, or when `NODE_ENV=test`.
- **The error**: `ToolSpawnInTestRunnerError`, code `E_TOOL_SPAWN_IN_TEST_RUNNER`, exit 8. It names
  the tool, the command and the marker it detected.
- **Opting in**: tests that mean to start a child process inject the real runner with
  `injectToolProcessRunner(spawnToolProcess)`. The tool-cache suites do this through a
  `useRealToolRunner()` helper.

Why: while test mocks were being retargeted, a stale mock let a vitest worker reach the real
runner and run `pnpm run test`. Every worker of that suite did the same, so whole-suite runs
multiplied across the machine. A cache hit never spawns, so it still returns.
