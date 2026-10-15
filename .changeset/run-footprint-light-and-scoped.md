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

A scoped build of a command `looksHeavy` rejects (`node scripts/x.mjs`, `ls`)
is now charged the light footprint, with a reason naming the tool. Shells,
`make`, package-manager scripts and CLEO itself keep the class plan, since they
run arbitrary commands. A git push or commit with an installed hook keeps the
plan, as before.
