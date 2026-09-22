---
id: t12310-successful-commands-report-failure
tasks: [T12310]
kind: fix
summary: A successful command no longer reports the work that just succeeded as failed
---

Every successful command wrote two diagnostics to standard error. Both were false in the same specific way: a true fact about the process, reported as an answer to a question nobody asked.

Path resolution scheduled the project encounter registration once per resolution rather than once per project. A single read scheduled two: the first committed, and the second was still in flight when teardown cancelled it. Its cancellation was then printed as `Project encounter registration failed` — naming, on a run whose envelope said the command succeeded, the one piece of work that had demonstrably just completed. The registration is now scheduled once per project per process, refreshed on a timer so a long-lived host still records that it saw the project, and is not started at all once teardown has begun. A best-effort operation stopped by teardown is abandoned, not failed, and is reported only under `CLEO_DEBUG`; a genuine registry conflict is still disclosed.

The teardown receipt declared every drain's producers `unassessed`, so the accompanying caveat printed even on runs where the barrier had observed no producer at all — nothing to assess, and a line regardless. The registry already stores each producer's own settled result, so the barrier now assesses them: it reports how many actually failed, distinguishes a producer cancelled by teardown and one discarded by its own transaction's rollback from one that failed, and says nothing when every producer succeeded. A drain that could not assess its producers still discloses that limit, because settlement alone never established success.

Assessment is recorded when each producer settles rather than by re-reading the registry, which is what makes the count exact. A descendant registered and settled inside one drain round is gone from the registry before a later round could poll for it, and a producer that failed long before teardown never appears there at all.

Code placed in packages/core/ for the teardown and path primitives and packages/contracts/ for the shared receipt shape per Package-Boundary Check — verified against AGENTS.md.
