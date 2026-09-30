---
id: dependency-cycle-guard
tasks: [T12886]
kind: fix
summary: a task dependency edge that closes a cycle is refused on every write path, with an error that names the cycle; `cleo doctor dep-cycles` reports cycles already stored
---

Nothing stopped `tasks_task_dependencies` from forming a cycle: the parent
cycle guard covers containment only, and no write path checked dependencies.
A cycle stalls every task on it, because `cleo next`, ready waves and
orchestration all wait for a blocker that waits for them.

- **DB guard.** A new `drizzle-cleo-project` migration adds
  `tasks_task_dependencies_cycle_guard_insert` and `_update` BEFORE triggers.
  They refuse a self-dependency and any edge whose target already reaches its
  source, for every writer including raw SQL, with `E_TASK_DEPENDENCY_CYCLE`.
  The recursive walk has one column and uses `UNION`, so each task is visited
  at most once. There is no depth cap to truncate a long chain. Re-inserting
  an edge that is already stored is not checked, so a store that holds an old
  cycle stays writable.
- **Named error.** `cleo update --add-depends`, `cleo add --depends` and the
  workgraph scaffold report the cycle, for example
  `T3 depends on T1 would close a dependency cycle: T3 → T1 → T2 → T3`. The
  error has exit code 14 (`CIRCULAR_REFERENCE`) and a fix hint that names an
  edge to remove.
- **Doctor.** `cleo doctor dep-cycles` lists the cyclic components with one
  cycle each and a repair plan. The plan is the edges whose removal breaks
  every cycle, each with its `cleo update <id> --remove-depends <dep>` command.
  The default `cleo doctor` run prints the same summary and exits 2 while a
  cycle remains. Both are read-only and never remove an edge.
- **Exodus.** Copying a legacy store suspends the new insert guard, as it does
  the other grandfathered guards. Historical cycles are copied as they are, and
  doctor reports them.

Cost: a refused edge over the deepest live chain (59 tasks) takes 0.025 ms. An
edge whose target reaches 13 000 tasks takes 6.5 ms. Re-inserting all 1 628
live edges takes 7 ms with the trigger and 1.3 ms without it.
