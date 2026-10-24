---
id: nexus-analysis-budget-followups
tasks: [T14016]
kind: fix
summary: "Budgeted NEXUS analyses skip community detection instead of overrunning, parse-cache checkpoints leave the parse hot path, and parser limits are part of the cache identity"
---

Three follow-ups to resumable analysis (T14009):

- **Community detection under a budget.** Leiden is synchronous and cannot be
  interrupted, so a budgeted run, such as the inline refresh a graph query
  starts, could overrun by Leiden's whole duration. A budgeted analysis now
  carries a deadline. Community detection runs only when its estimate fits the
  time left: the estimate is the previous run's measured community phase, with
  a per-edge minimum. Otherwise it is skipped, and the run summary says so in
  `communitiesSkipped`. A skip keeps the last measured cost, so the next
  budgeted run's estimate does not fall to the minimum. Until a later analysis
  detects communities again, every graph answer from that generation carries
  `data.freshness.communitiesSkipped` and warns with
  `W_NEXUS_COMMUNITIES_SKIPPED`. `cleo nexus analyze` without a budget always
  detects communities.
- **Checkpoints off the parse hot path.** Parse-cache checkpoints were one
  synchronous SQLite transaction every 64 parsed files, written inside the
  callback that receives each parse result. A timer now writes them every 2s.
  A full queue only brings the write forward, and the end of the parse
  flushes the rest. On a 400-file fixture, a fast parse writes once instead
  of 7 times.
- **Parser limits in the cache identity.** `maxSourceBytes` and `timeoutMs`
  decide whether a file extracts at all, so a cache entry is now reused only
  under the same limits. Before, an entry made under looser limits could be
  reused under tighter ones, and the incremental graph could differ from a
  full rebuild. The default limits keep the plain extractor fingerprint, so
  existing caches stay valid.
