---
id: t12896b-brain-remaining
tasks: [T12896]
kind: feat
summary: "Memory trees are recomputed per device; brain task-observation links sync with natural row uids"
---

`brain_memory_trees` is now classified derived: the surprisal pass rebuilds it
every cycle on each device from the synced observations, so it is never
captured or replicated (its writer is a recorded non-sync exemption).

`brain_task_observations` joins the consolidated project schema (migration
`20261010170000_t12896b-brain-task-observations`, every statement IF NOT EXISTS
so stores that already have it keep their rows), and is declared natural on
(observation id, task uid). Its integer id stays a local key. A fresh store has
the table, its uid column and its unique uid index before the open's identity
heal; an older store gets the column from the migration or the heal.
