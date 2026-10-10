---
id: right-size-heavy-footprints
tasks: [T13367]
kind: fix
summary: cleo run charges a command by its real scope, so a two-file formatter run no longer queues behind 24 GiB reservations
---

The heavy-command hook routes `biome check a.ts b.ts` through
`cleo run --class build`. Every ledger class was charged the full heavy-run
plan (24 GiB on a 48 GiB machine), so cheap checks waited minutes behind
builds or exited 75 (deferred).

`cleo run` now sizes the charge from the command:
- biome on named paths is charged the light footprint (1 GiB);
- eslint or prettier on named files, and `tsc -p` on one project, are charged
  one process;
- everything else keeps its class plan. That includes root builds, `tsc -b`,
  a linter on the whole tree, and an explicit `--class full-build`.

A named-file test run keeps its per-file worker cap. The reason is recorded
on the ledger entry and shown in the holder line and in
`cleo doctor tool-locks` (`footprintReason`).

A queue head blocked by bytes past its reservation still stops heavier runs
behind it. Up to three tiny runs (1 GiB or less) that fit the memory budget
may now pass it, until the head has waited three reservation windows (6 minutes), and never a head that needs the whole budget. Steady small arrivals cannot starve it.
