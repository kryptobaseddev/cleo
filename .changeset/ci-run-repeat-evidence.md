---
id: ci-run-repeat-evidence
tasks: [T14149]
kind: feat
summary: "a criterion that needs a heavy or repeated run is proven in CI: repeat-run.yml repeats a test file N times on main and ci-run:<runId> records it as evidence, replacing the owner AC waiver"
---

Criteria such as "50 consecutive runs pass" used to be waived by the owner,
because the owner rule forbids heavy local runs and nothing else could run
them (T13047 AC2, T12217 AC2). The new `.github/workflows/repeat-run.yml`
runs a test file N times (1-200) on the default branch, on a runner, with a
90-minute cap and its own concurrency group. The dispatch inputs pass
through `env:` and are validated before anything runs: the file must be a
tracked repo-relative test file, and the count an integer.

`ci-run:<runId>` records such a run. CLEO checks it on GitHub:

- the workflow is `repeat-run.yml`;
- it was started by a dispatch on the default branch;
- its latest attempt is green;
- its uploaded report matches its title: the same file, count and commit,
  with every run green.

The run's commit must contain the task's implemented work, and the repeated
file must be one the task changed or one a linked criterion names. The atom
links criteria and never satisfies `testsPassed` on its own.
`cleo complete` re-reads the run and refuses a newer attempt that is not
green. There is no new waiver or override path.
