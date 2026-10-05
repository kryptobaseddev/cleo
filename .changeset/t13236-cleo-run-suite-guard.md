---
id: t13236-cleo-run-suite-guard
tasks: [T13236]
kind: fix
summary: cleo run refuses a vitest run that names nothing (the whole suite, usually from an empty file list) unless --whole-suite, and refuses to start anything inside a test runner
---

`cleo run` now refuses `vitest run`, `pnpm exec vitest run` or `npx vitest run` when the
command names no test file, directory, `--project`, `-t` filter, `--changed` or
`--related`. Such a run is the whole suite, and the usual cause is an empty generated
file list: `vitest run $files` with `$files` empty. That has twice run a whole package
suite by accident.

- The refusal exits 6 and names the remedy: name the files, and check that a generated
  list isn't empty.
- `cleo run --whole-suite -- <cmd>` runs a whole suite on purpose.
- The heavy-command hook rewrites commands into `cleo run`, so a hooked command gets the
  same refusal. This covers a list that expands to nothing at run time.

`cleo run` also refuses to start a command inside a test runner (`VITEST`,
`VITEST_WORKER_ID`, `JEST_WORKER_ID`). It exits 8 with `E_RUN_SPAWN_IN_TEST_RUNNER`. A
stale mock can therefore no longer start a suite again from one of that suite's own
workers. This is the T13203 guard applied to `cleo run`. A test that means to start a
process passes `deps.spawn` (`spawnGovernedChild`) to `runGoverned`.

Any process that inherits `VITEST`, `VITEST_WORKER_ID` or `JEST_WORKER_ID` now refuses to
start a tool. That covers the evidence tool runner (T13203) and `cleo run` (this change),
and also a built `cleo` that a test spawns with the test's own environment. An end-to-end
test that starts the CLI must either scrub those variables from the child's environment
(build the env explicitly, as `run-hook-contract.test.ts` does) or opt in through an
injected runner or spawner.

