---
id: t13846-ci-job-descendant
tasks: [T13846]
kind: fix
summary: "ci:<pr> looks past a later main run that skipped the test jobs to the next one where they ran"
---

When a PR's merge-commit CI run was cancelled by a newer merge, `ci:<pr>` lets
a later main run stand in (T12742). It took the first later run whose required
checks were green. If that run came from a scripts-only or docs-only merge,
its change filter skipped the Unit Tests jobs. `cleo done --pr` then refused
`testsPassed` with "job Unit Tests*: not found … on <merge sha>". That was the
#2330 repro.

The stand-in search now also requires the code task's job globs
(`evidence.ciChecks.jobs`). A later run that never ran them (not found,
skipped or cancelled) is passed over for the next candidate. A job that
failed there still refuses, and a pending one waits. All existing T12742
guards still apply: the PR head must be green, the candidate must be within
10 commits and 7 days, and nothing in the range may touch the PR's files or a
CI definition.
