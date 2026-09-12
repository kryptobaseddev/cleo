---
id: p0-process-lifecycle-and-memory-kernel
tasks: [T12115, T12116, T12117]
kind: fix
summary: a cleo command now finishes, exits, and never loses a write — bounded teardown, a single-process bin shim, a kernel-enforced memory ceiling for heavy tools, and fail-open duplicate detection (gh#1228, gh#1229, gh#1237, gh#1241, gh#1244, gh#1207)
---

Three defects that together explain how CLEO could degrade the host it runs on.

**A command could finish and never exit.** `shutdownCliRuntime` bounded nothing:
its `safely()` helper swallowed throws but awaited each teardown step forever,
and a promise that simply does not settle is not an error. Because closing the
databases is step 3 of 4, a stall in step 1 or 2 left SQLite descriptors open
indefinitely — measured on a live host as `cleo update` resident **12.9 hours**
in `ep_poll`, envelope printed hours earlier, with 31 such processes holding
3.25 GiB while the box ran 13 GiB into swap. Every step is now deadline-bounded,
and the CLI arms an **unref'd** exit backstop that names the live handles on
stderr. Unref'd is the whole trick: a healthy process still drains its loop and
exits on its own, so the "drain, then exit" contract is preserved and the
backstop fires only in the case that used to hang forever.

The stall had a specific source: `EmbeddingQueue.doShutdown` *started work while
shutting down*, spawning a worker and scheduling callbacks that each load a
transformers.js model on the main thread. Shutdown is now purely subtractive.

**Every `cleo` call was two Node processes.** `bin/cleo.js` re-executed the CLI
through `execFileSync` purely to set two Node flags. That paid Node boot twice
per command and — because `execFileSync` blocks the shim's own event loop —
meant SIGTERM to the shim never reached the child, orphaning it by construction.
The flags now ride the shebang via `env -S`; the re-exec survives only for the
`CLEO_MAX_OLD_SPACE_MB` override and non-POSIX shims, and forwards signals.

**Heavy tools had no real ceiling.** `VITEST_MAX_WORKERS` binds vitest and
nothing else, and `--max-old-space-size` caps the V8 old space rather than RSS,
so a consumer running `cargo test`, `pytest`, `go test` or `make` was unbounded
— and all of it was advisory anyway. `test` and `build` now spawn inside a
transient systemd scope with a hard `MemoryMax` and `MemorySwapMax=0`. The bound
is the kernel's and covers the whole process tree, so a `pnpm -r` fan-out into
fifteen packages is one cgroup. Denying swap is the point: the incident being
guarded against was never an OOM kill but a throttle-and-thrash freeze that
logged nothing, which is why repeated OOM hunts found nothing. Degrades to an
unwrapped spawn off Linux or without a user systemd manager.

**A write could be lost to enrichment.** `checkDuplicates` runs *before* the
insert and called the vector tier inside the per-candidate loop over every
active task, so `cleo add` performed one local embedding inference per active
task before committing a row — cost scaling with project size. Detection is now
bounded by candidate count, by wall clock, and in aggregate, and **fails open**:
budget exceeded means the task is still created, with a warning. The row is the
product; duplicate detection is enrichment.
