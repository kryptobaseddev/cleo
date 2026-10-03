---
id: t13133-admission-ledger
tasks: [T13133]
kind: fix
summary: "One admission ledger replaces the tool semaphore's slots, the governor's test/build/full-build slots, cleo run's per-class queues and the darwin one-slot rule: every heavy run shares one machine-wide memory budget and one FIFO queue, a run nested in an admitted run rides its admission (verified by process ancestry, not an env var), and a waiter blocked for a minute names the holders and any suspected wait cycle"
---
- **One admission point.** Before this change, heavy runs passed several
  layers, each bounding only what it could see: per-tool slot directories
  (`<cleoHome>/locks/tool-*`), governor class slots
  (`locks/resource-test-run` etc.), `cleo run`'s `run/queue/<class>` tickets,
  and the darwin one-slot rule. A `cleo verify` took a tool slot, then a
  governor slot. A `cleo run` took only the governor slot, and its child could
  then wait on the tool slot. That cross order deadlocked the machine queue
  for 20 minutes on 2026-10-03. Now every evidence run, every `cleo run` job
  and the vitest project probe asks one ledger,
  `<cleoHome>/admission/ledger.json`, for a share of one budget. The old
  layers are deleted.
- **Bytes, not runs.** The budget is total RAM minus `max(4 GiB, 25%)`, so a
  48 GiB Mac gets 36 GiB. Each run asks for its footprint:
  - a heavy test or build run: its worker count × 6 GiB;
  - typecheck: 5 GiB;
  - lint, scans and the probe: 1 GiB.

  A run larger than the budget runs alone. Memory pressure narrows the budget:
  `hold` halves it, CPU saturation admits one run at a time, and the memory
  gate (T13127) admits nothing. When nothing else is running, the oldest
  waiting run always starts.
- **Fair queue.** Runs are admitted FIFO, with backfill: a small run may start
  ahead of a big one that does not fit yet. After two minutes the oldest
  waiting run holds a reservation and nothing passes it, so neither big nor
  small runs can starve.
- **Re-entrant, and it cannot be forged.** A grant exports
  `CLEO_ADMISSION=<id>.<nonce>` to the tool or job it starts. A cleo command
  run inside that process tree rides the grant: no new budget, no wait. The
  caller must actually descend from the holder (process ancestry, or a tool
  process group the holder started) and the holder's start time must match,
  so setting the env var by hand grants nothing. A wrapper that scrubs the
  environment is still recognised by ancestry.
- **A long wait explains itself.** After a minute, a waiter prints the
  holders with pid, command, directory, share and age. When a holder's
  process tree and the waiter's ancestry run the same wrapper program (the
  `run.sh` inversion), it flags a suspected wait cycle. Memory-pressure waits
  keep their "waiting: memory pressure" line.
- **Safe state.** The ledger is read, decided and written inside a
  `proper-lockfile` critical section that does no probing, sampling or
  spawning. A test with 20 concurrent admitters shows no lost update and no
  deadlock. An entry is dropped once its holder is provably gone: the pid is
  gone (or recycled, judged by start time) and every tool group it started is
  gone. An unwritable CLEO home makes runs ungoverned rather than stuck.
  `CLEO_RESOURCES_MODE=off` still turns admission off.
- **Deprecated: `CLEO_TOOL_CONCURRENCY_<TOOL>`.** It no longer counts
  anything. `0` (or less) still bypasses admission for that tool; any other
  value is ignored. Either way, one deprecation line is printed per process,
  on stderr only.
- **Status.** `cleo doctor tool-locks` now lists the ledger: who holds the
  budget, who waits, and whether each holder is alive. `--reap` drops
  entries whose holders are gone. The janitor removes the old slot
  directories once nothing holds them.
