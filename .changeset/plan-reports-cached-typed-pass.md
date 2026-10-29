---
id: plan-reports-cached-typed-pass
tasks: [T14138]
kind: fix
summary: "cleo done --plan reports a typed-gate pass cached by cleo verify --run as cached, or names the cache-key part that misses"
---

`cleo verify --run` caches a typed gate's pass without recording it, and the
next evidence write binds it. `cleo done --plan` read only the stored results,
so it reported such a gate as not-run and blocked on it (VidaPeps T2294).
The plan now probes the evidence cache for each typed gate with nothing
stored. A hit reads as `cached`, with its time, and raises no blocker. A miss
keeps `not-run`, and the blocker names the key part that moved since the
last cached pass: HEAD, uncommitted changes, the execution root, or the
inputs and environment.

The probe is read-only. It runs no gate, writes no cache entry, and never
creates the machine key. The cache key never included the session; the
plan simply did not look.
