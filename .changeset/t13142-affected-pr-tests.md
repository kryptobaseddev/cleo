---
id: t13142-affected-pr-tests
tasks: [T13142]
kind: chore
summary: Pull-request CI runs the unit tests of the changed packages and their dependents; main and nightly run the full suite
---

Each PR ran all four unit shards over the whole suite, whatever it changed. A pull request's
unit shards now run the vitest projects of the packages it changes plus their workspace dependents,
and the package-less `scripts` project: the set `tool:test-affected` runs locally. A change outside
every package (a root config, the lockfile, a workflow), a changed package no project covers, or any
error runs the full suite. Main pushes, the nightly run, merge groups and dispatches always run the
full suite, so coverage is unchanged and only its timing moves.
