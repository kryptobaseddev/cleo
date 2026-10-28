---
id: t14116-charge-follows-measured-peak
tasks: [T14116]
kind: fix
summary: "an admitted cleo run's charge now falls to its measured peak plus a margin after a warm-up, freeing budget for waiting runs, and returns to the plan if the run grows"
---

A run was charged its planned footprint for as long as it ran. An axiom
`git push` charged 12 GiB measured 0.17 GiB, and a typecheck charged 12 GiB
measured 4.1 GiB, so 24 GiB of budget was held by about 4.3 GiB of real use
while every other lane queued.

`cleo run` now reports each tree measurement to its ledger grant. After a
60 s warm-up and two measurements, the charge falls to the measured peak plus
a margin (a quarter of the peak, at least 512 MiB), never above the plan, and
the same ledger pass admits waiters with the freed budget. A run whose tree
climbs past its lowered charge is charged its plan again. Holder lines in the
wait report and `cleo doctor tool-locks` show the current charge, the plan
and the measured peak.
