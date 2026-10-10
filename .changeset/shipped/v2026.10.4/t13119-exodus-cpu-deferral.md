---
id: t13119-exodus-cpu-deferral
tasks: [T13119, T13150]
kind: fix
summary: On a busy Mac, opening a legacy project no longer skips the exodus migration and serves an empty store
---

When a project still has its pre-consolidation stores (`tasks.db`, `brain.db`), the first open fills
the new `cleo.db` from them (exodus-on-open). That migration passes the resource governor's
`db-heavy` admission, which defers it under `backoff`-level pressure. Since the macOS pressure backend
(T12981, v2026.10.3), macOS computes that pressure from CPU, and derives CPU from the load average.
So any Mac whose load exceeded twice its effective cores (a Mac running agents, a CI runner under
vitest) deferred the migration on every open. The command then read the empty `cleo.db`, so the
tasks looked missing. A write in that state populated `cleo.db`, after which on-open never migrated
again and the legacy rows stayed stranded until a manual reconcile. Linux samples carry no CPU
signal, so only macOS was affected.

Exodus-on-open now asks for admission on memory pressure alone (`ignoreCpuPressure`). CPU saturation
slows a migration but cannot exhaust memory, and memory exhaustion is what the governor guards
against. Memory pressure still defers it.

This fixes the two macOS-only test failures: `exodus-reconcile` "on-open first" and `upgrade`
"migrates the OWNER store and audits the run". Both were deferrals on a loaded runner.
