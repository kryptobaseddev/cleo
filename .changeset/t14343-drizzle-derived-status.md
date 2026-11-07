---
id: t14343-drizzle-derived-status
tasks: [T14343]
kind: refactor
summary: "the drizzle derived-status SQL is built from the same task-claim builder as the bound and inlined forms"
---

`derivedStatusSql(now)` in the SQLite accessor rebuilt the derived-status
CASE by hand from drizzle column refs, a third copy beside the task-claim
builder. It now joins `derivedStatusSqlParts('tasks_tasks')` around its bound
`now`, so the bound, inlined and drizzle forms come from one builder. The
derived-status test checks all three return the same statuses.
