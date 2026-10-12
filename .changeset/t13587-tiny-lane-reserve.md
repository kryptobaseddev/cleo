---
id: t13587-tiny-lane-reserve
tasks: [T13587]
kind: fix
summary: "A tiny run (1 GiB or less, e.g. biome on named files) is admitted from a reserve outside the pressure share, so a holder filling a halved budget cannot starve it"
---

A tiny run at the head of the queue waited behind a holder that filled the pressure-halved light budget exactly: the tiny lane only passed a blocked head and still required the run to fit that budget. Up to `TINY_LANE_SLOTS` (3) tiny runs are now admitted from a reserve outside the pressure share, wherever they wait. Their bytes do not count against the share budget, and other runs never use the reserve. The reserve stays within the machine capacity (shared use plus reserve never exceeds it), reserve runs count as running so a capacity-sized run is not started beside them, and the memory gate's `none` still admits nothing. A 24 GiB holder on a halved 48 GiB budget now admits a 1 GiB formatter at once.
