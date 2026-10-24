---
id: nexus-refresh-cost-gate
tasks: [T14014]
kind: feat
summary: "NEXUS inline refresh is gated by a size-scaled cost estimate, not a 25-file cap and a 30% stale gate"
---

A graph query refreshes a stale index inline whenever the estimated refresh fits
`nexus.autoRefresh.budgetMs`, however many files are stale. The estimate scales
the last run's whole-graph cost (resolution, communities, flows, publication)
to today's file count and adds the stale files at the last run's parse rate;
decoding reused extractions is now timed apart (`reuseDecode`) so it no longer
inflates that rate. The refresh runs in the heap-bounded child, resumes cached
extractions and honours the budget in every phase, so a large stale set that
fits the budget is refreshed instead of refused. `nexus.autoRefresh.maxFiles` is
retired and ignored.

Freshness also reports `changedFilesSinceIndex`: tracked files changed since the
indexed revision, from `git diff --name-only`, without walking the tree. It is
reporting only; the manifest walk and the publication's hash checks stay
authoritative.

Inline refresh is guarded so a stale index never turns every query into another
heavy run: one inline refresh at a time per project (a pid lock; a concurrent
query answers from the stale index), a refresh that parses more than 25 files
or 30% of them only when a non-waiting `cleo run` admission grants it, and a
30-minute cooldown after a refresh fails or is aborted (reported as
`freshness.refreshCooldownUntil`, lifted by the next successful analysis). The
estimate counts files without an exact cache entry for this build at the parse
rate, and declines to scale a recorded run more than 4x.
