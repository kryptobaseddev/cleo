---
id: t14346-derived-status-in
tasks: [T14346]
kind: refactor
summary: "derivedStatusIn builds its live-lease predicate from the task-claim builder"
---

The drizzle status filter `derivedStatusIn` hand-built the live-lease
predicate from column refs, the last copy outside `task-claim.ts`. It now
joins `liveClaimSqlParts('tasks_tasks')` around its bound `now`, through the
same split helper as `derivedStatusSqlParts`. The derived-status test checks
the filter selects exactly the ids each status reads with.
