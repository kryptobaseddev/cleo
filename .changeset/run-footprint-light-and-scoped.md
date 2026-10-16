---
id: run-footprint-light-and-scoped
tasks: [T13452, T13759]
kind: fix
summary: cleo run charges a non-heavy command light and a scoped build half a heavy run, so independent builds stop serializing the machine
---

Every `run:scoped-build` was planned with a whole heavy run's workers. On a
64 GiB Mac that is 4 workers × 6 GiB = 24 GiB, which is the entire heavy budget
once pressure halves it, so only one scoped build ran at a time across every
project. A scoped build is one package: it now plans, and is spawned with,
half a heavy run's workers rounded up (2 workers, 12 GiB on 64 GiB), so two fit
a halved budget. Test runs and full builds keep their plans; a full build is
never shrunk.

A scoped build of a command on a small allowlist is charged the light
footprint, with a reason naming it: file utilities (`ls`, `cat`, `echo`, …) and
`node` running a plain `.js`/`.mjs`/`.cjs` script with no node flags, outside
`node_modules/` and without a heap-raising `NODE_OPTIONS=` prefix. Wrappers
(`timeout`, `sudo`, `env`, `nice`, `command`, `exec`) are stripped first.
Everything else (cargo, go, pytest, gradle, docker, shell scripts, `node
--test`) keeps the class plan. A git push or commit with an installed hook keeps
the plan, as before.

A nested run rides an enclosing grant only when that grant is a heavy run's or
covers the request. Under a light grant a heavier run queues for itself and
records its parent; scheduling considers it first and leaves its ancestors out
of the budget, `one`, exclusive and idle checks, so it never waits on the run
that is waiting for it. Typed gates, which are
spawned with the whole heavy-run environment, are charged the whole heavy run
for a worker-pool plan.
