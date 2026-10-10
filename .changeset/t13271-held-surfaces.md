---
id: t13271-held-surfaces
tasks: [T13271]
kind: feat
summary: Held sync rows surface in cloud status, cleo doctor sync-journal and pull results
---

Journal spec §3.5 Rule 5: rows a sync rebase holds are now visible in three places.

- **`cleo cloud status`.** Each store's sync block (`CloudStatusSyncStream.held`) gives:
  - how many local ops are held;
  - when the oldest was held;
  - the holds older than `HELD_WARN_DAYS` (7), each with its blocking conflict.

  The human line reads, for example, "2 held by a rebase (1 older than 7 days)".
- **`cleo doctor sync-journal`.** The result has a `holds` report: the total, the oldest, and the long holds with their reasons.
- **Pull results.** `ApplyReport.held` lists the local transactions a call left held. A transaction held on one page and applied on a
  later page of the same call is not listed.
