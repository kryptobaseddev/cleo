---
id: t13170-cpu-not-a-gate
tasks: [T13170]
kind: fix
summary: A busy CPU no longer defers the sentient tick or other db-heavy work; the governor budgets every class but heavy test and build runs on memory pressure alone
---

The resource governor protects memory. Since the macOS pressure backend (T12981), macOS computes CPU
pressure from the load average, which counts a busy but healthy machine (a Mac running agents, a CI
runner under vitest) as `backoff`. Every governor class took that combined score, so `db-heavy` work
was deferred on CPU alone. The sentient tick was skipped on every busy interval, so the dream trigger
never fired: `dream-cycle.test.ts` DC-13, 14, 16 and 19 failed on macOS runners. v2026.10.4 fixed only
exodus-on-open, with a per-caller `ignoreCpuPressure` flag.

- **Memory is the gate.** `db-heavy` and `background-autonomous` are budgeted on memory pressure
  alone (PSI `some`/`full` on Linux, the derived memory score on macOS). CPU saturation slows work;
  it cannot exhaust memory.
- **CPU narrows only heavy runs.** `test-run` and `scoped-build` still count CPU saturation, because
  more workers on saturated cores only slow every one of them.
- **No per-caller exemptions.** `ignoreCpuPressure` is removed; exodus-on-open gets memory-only
  admission from the governor itself, and still defers at once under memory pressure.
- **Deferral reasons** name the signal used: `memory some avg10=…` for memory-budgeted classes.
