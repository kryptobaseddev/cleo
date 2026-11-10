---
id: agent-registry-prefixed-table
tasks: [T14387]
kind: fix
summary: "registering an agent bound to a task or session no longer fails with FOREIGN KEY constraint failed: the agent registry reads and writes tasks_agent_instances"
---

The agent registry, capacity and capacity-tracker modules wrote the bare
`agent_instances` and `agent_error_log` tables. The bare `agent_instances`
carries foreign keys to the bare `tasks` and `sessions` tables, which the
runtime stopped writing when tasks moved to `tasks_tasks`, so every
`registerAgent` call with a `taskId` or `sessionId` failed its FK check.

They now read and write only the prefixed `tasks_agent_instances` and
`tasks_agent_error_log`, which hold the same columns with plain-text ids.
Rows already in the bare tables are left untouched.
