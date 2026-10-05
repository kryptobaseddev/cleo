---
id: t13236-cleo-run-suite-guard
tasks: [T13236]
kind: fix
summary: cleo run refuses a whole-suite test run nobody asked for (a vitest run naming nothing, an empty or '.' filter, or pnpm test) unless --whole-suite, and refuses to start anything inside a test runner (exit 8)
---

`cleo run` now refuses `vitest run`, `pnpm exec vitest run` or `npx vitest run` when the
command names no test file, directory, `--project`, `-t` filter, `--changed` or
`--related`. An empty or blank argument, `.` and `./` don't count as naming anything:
`vitest run "$files"` with `$files` empty passes `''`, and vitest's substring filter `''`
matches every file. A package-manager script that runs vitest is treated the same way:
`pnpm test`, `pnpm run test`, `pnpm -r test` and `pnpm --filter <pkg> test` (every `test`
script in this repo is `vitest run …`) are refused unless your own arguments narrow them,
as in `pnpm test path/to/a.test.ts`. The script is read from the nearest `package.json`; a
script that doesn't run vitest is never refused, and a `--filter` alone still runs that
package's whole suite. Such a run is the whole suite, and the usual cause is an empty generated
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

