---
id: t13242-t13243-parts-status-stage
tasks: [T13242, T13243]
kind: fix
summary: A split transaction with one unreadable part is refused whole, and a task's terminal status always fixes its pipeline stage after a merge race
---

Two follow-ups from the review of the apply slices.

- **Split transactions refused whole (T13242).** When any part of a split transaction is refused (unreadable, or from a newer
  format), every part of the same (replica, txn) is refused with it, now or when a later part arrives. Before, the other parts stayed
  staged forever.
- **Status fixes the stage (T13243).** `SYNC_MERGE_RULES.tasks_tasks.coupled` maps `done` to `contribution` and `cancelled` to
  `cancelled`, as the domain does (T871, T877). After a cancel and a completion race, status and stage always agree, whichever status
  wins its LWW.
  - The imposed value is marked `derived`. It is never a rank-max candidate, and the column's real candidates are kept underneath, so a
    status that leaves the terminal state returns the stage to the same value in every order.
  - The value is recomputed at every op that carries the status or the stage, so an unrelated or refused write never rewrites a stage.
  - A new property test (P8) folds cancel/complete races with the stages the domain writes, in every interleaving: the state converges
    and status and stage match.
