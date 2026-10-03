---
id: t13127-memory-pressure-gate
tasks: [T13127]
kind: fix
summary: "Heavy work is now refused, not merely narrowed, while the machine is short of memory: test, build, typecheck and install admissions (cleo run and cleo verify evidence runs) wait with a 'waiting: memory pressure' notice and the readings, and start when pressure falls. macOS scores swap and compressor occupancy, so a Mac with swap nearly full is finally seen as under pressure"
---
- **Refused under memory pressure.** The governor's heavy classes
  (`test-run`, `scoped-build`, `full-build`) used to floor at one slot, so one
  more suite or build was always admitted however full swap was. A memory gate
  now refuses them while memory pressure is above 25 (PSI `some avg10` on
  Linux, the derived score on macOS) or `full avg10` is above 10. Once it
  refuses, it admits again only at 15 or below, so admission does not flap at
  the threshold. The refusing state is shared machine-wide through
  `<cleoHome>/locks/memory-gate.json`, so a newcomer cannot start while others
  wait. CPU saturation never refuses work. It still narrows budgets and pauses
  younger `cleo run` jobs as before. Work nested in an admitted `cleo run` job
  (verified by process group or ancestry, not by the env var alone) is never
  held back, because the job would otherwise wait on its own child.
- **Waiting says why.** `cleo run --wait` (and the provider hook, which uses
  it) prints `waiting: memory pressure <score> (refused above 25, resumes at
  15 or below): <readings>` at most once a minute. When pressure falls it
  prints `memory pressure fell … admitting the … job` and starts. Both are
  warnings, so `--passthrough` shows them too. Without `--wait`, the
  `E_RESOURCE_DEFERRED` envelope carries the readings in
  `details.memoryPressure` and a memory remedy. `cleo verify --evidence
  tool:test|tool:build|tool:typecheck` waits the same way before it queues for
  a tool slot, printing the same lines on stderr.
- **macOS sees swap and the compressor.** The darwin backend reads
  `vm.compressor_bytes_used` in the same single `sysctl` exec (no `vm_stat`
  spawn, cached for 2 s). Memory now scores how much of RAM is wired or
  compressed (`kern.memorystatus_level`, or the compressor's share), plus swap
  in proportion as that squeeze rises from 30% to 50% of RAM. The kernel level
  still counts too (warning 15, critical 40). A captured loaded state (kernel
  warning, 41% neither wired nor compressed, 11.4 GiB swap on 48 GiB) used to
  score 15, hold, and kept admitting heavy work. It now scores about 43 and is
  refused. Old swap on a Mac with RAM to spare still scores 0.
- **Fails open.** A sample without a memory signal (no PSI, a failed
  `sysctl`, a sampling error) never refuses and never touches the shared
  state. An unwritable CLEO home falls back to per-sample decisions, and a
  refusing state nobody refreshes expires after 60 s. Lasting pressure blocks
  only until the caller's own timeout, which reports the readings.
  `CLEO_TOOL_CONCURRENCY_<TOOL>` and `CLEO_RESOURCES_MODE=off` still bypass
  admission.
