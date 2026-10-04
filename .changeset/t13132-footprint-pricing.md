---
id: t13132-footprint-pricing
tasks: [T13132]
kind: fix
summary: "A whole-suite run no longer takes the whole machine budget: heavy runs plan for half of it, every run is charged what its plan lets it start, a single-file test run takes one worker's share, CPU saturation narrows only heavy runs, and status marks whole-suite runs with their project and task"
---
On 2026-10-03 one agent's `cleo verify --evidence tool:test` ran the whole suite (no
`affectedCommand`) and held the machine-wide test slot for 17 minutes while 49 waiters,
most of them single-file test runs that need one worker for seconds, queued behind it.
The admission ledger (T13133) already counts bytes, not runs; this change sizes and
prices the runs it admits.

- **Half the budget per run.** A heavy test or build run plans its workers for half of
  the admission budget (`PER_RUN_BUDGET_SHARE`): 3 workers on a 48 GiB Mac (18 of the
  36 GiB budget), 4 on 64 GiB, 6 on 128 GiB and up, 1 on 16 GiB. It used to plan for the
  whole budget (6 workers on 48 GiB), so nothing else could run beside it. A whole-suite
  run is slower; two heavy runs, or one and many light ones, now share the machine. The
  count depends on RAM alone, so the tool cache key (which includes it) stays stable.
- **Charged what it can start.** An evidence run is charged its plan: workspace packages
  in flight × workers × (heap + 2 GiB) — the limits it is spawned with, so the charge is
  enforced, not estimated. A `cleo run` of a test command that names its test files
  (`vitest run a.test.ts`) plans, is charged and is spawned with one worker per named
  file, so a single-file run takes one worker's share, not a whole suite's.
- **CPU saturation narrows heavy runs only.** Under CPU saturation one heavy run (more
  than one worker's footprint) runs at a time, as before, but typecheck, lint, single-file
  test runs and the config probe are budgeted on memory pressure alone and keep running
  beside it.
- **Status names what holds the budget.** Ledger entries record the run's scope
  (`full` for a whole-suite evidence run, `affected`, `narrowed`) and its task. They show
  in holder reports (`tool:test [scope=full, task T1043] pid …`), in a `cleo run`
  deferral's `running` list (with the bytes held), and in `cleo doctor tool-locks`.
- **macOS headroom is reclaimable memory** (follow-ups from the #1806 review): headroom
  is now free + speculative + file-backed + purgeable pages (`vm.page_*_count` ×
  `hw.pagesize`, read in the same sysctl exec), not the share of RAM neither wired nor
  compressed, which counted memory apps hold as free. The floor below which headroom
  scores is a quarter of RAM, at least 6 GiB, at most half of RAM (it was a fixed 6 GiB).
  `memAvailableBytes` on macOS is the reclaimable figure, and pressure summaries print it.
