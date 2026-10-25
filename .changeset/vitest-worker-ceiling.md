---
id: vitest-worker-ceiling
tasks: [T14033]
kind: fix
summary: "cleo run and tool:test no longer turn a serial vitest suite (fileParallelism: false, maxWorkers 1) parallel"
---

vitest 4 applies `VITEST_MAX_WORKERS` after it resolves the config, over the
`maxWorkers = 1` that `fileParallelism: false` or `--no-file-parallelism`
sets. CLEO exported its RAM-derived worker count there on every test run, so
a project that runs its files one at a time (for example, two files sharing
one database) got two or more at once and failed.

A test run now plans at most the project's own limit: the lowest literal
`fileParallelism: false` or `maxWorkers: N` in the vitest configs of the run's
directory and two levels below it (workspace packages), or the same setting
on the command line. The CLEO bound still applies when the project sets
nothing lower, so it only ever lowers the effective parallelism. This covers
`cleo run --class test`, `tool:test` evidence and typed test gates.
