---
id: t14330-studio-tasks-tables
tasks: [T14330]
kind: fix
summary: "Studio reads tasks_tasks and its prefixed siblings, not the empty legacy tasks tables, and derives active from the claim lease"
---

Studio's raw SQL read the bare `tasks`, `task_dependencies`, `sessions` and
`task_work_history` tables. In a consolidated `cleo.db` those are the empty
legacy decoys, so the dashboard counts, epic progress, task detail,
pipeline, sessions, the brain stream's task events, reason-why and the
cross-substrate graph showed nothing. Every site now reads the prefixed table
(`tasks_tasks`, `tasks_task_dependencies`, `tasks_sessions`,
`tasks_task_work_history`), and each task status it reads is derived from
the claim lease (`derivedStatusSqlAt` in `@cleocode/core/store/task-claim`).
reason-why also read a `dep_id` column that never existed; it reads
`depends_on`.
