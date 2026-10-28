---
id: never-pause-test-runs
tasks: [T14093]
kind: fix
summary: "cleo run never pauses a run that executes tests (class test, a test runner or script, node --test, a hooked git push or commit); pressure queues it instead"
---

`cleo run` SIGSTOPped test runs and hooked pushes under memory pressure.
A test's wall-clock timeout keeps counting while the process is stopped. In
axiom-qa's report, a `git push` whose pre-push hook runs vitest was paused
542 s of a 548 s run. Its 60 s test timeouts fired, the hook failed and the
push was blocked. `--no-pause` (T14075) was opt-in, and a hook-carried test
run cannot be expected to pass it.

- `testPauseExemption` names why a run must not be paused: the `test` class;
  a command that is a test run whatever class it was given (a test runner, a
  `test` script, `cargo`/`go test`, `node --test`); and a `git push` or
  `git commit` whose installed hook `gitHookFor` finds. `isPausable` is false
  for all of them.
- Such a run is handled like a `--no-pause` run. It starts only below
  backoff, waiting in the queue with `--wait` or deferred otherwise, and is
  never paused once running. stderr says `never paused: <reason>`, and the run
  envelope carries `notPausable`.
- Builds, typechecks, lint, and a git push with no hook installed still pause
  as before.
