---
id: t14206-progress-guarantee
tasks: [T14206]
kind: fix
summary: "Admission always makes progress under outside memory pressure: one small run at a time passes the memory latch unless memory is critical, and light commands are no longer held by it"
---

When non-CLEO programs hold the memory pressure latch, CLEO's queue used to make
no progress at all: a 1 GB biome check, git pushes and a global install waited
for hours with nothing of CLEO's running. Now, while the memory gate refuses
and memory is not critical, one small run at a time passes the latch in queue
order, when its charge fits the reclaimable memory:

- a light run (charged 1 GiB or less, not lowered from a heavier plan) passes
  whatever else CLEO runs;
- a run whose measured charge is under 1 GiB passes while CLEO holds nothing.

Larger runs keep waiting and, held above the refuse line, get the
`E_RESOURCE_EXTERNAL_PRESSURE` verdict. Memory is critical, and nothing starts
through the latch, when tasks are stalled on memory (full stall above 10),
macOS reports its critical pressure level, or swap is at least 90% full.
