---
id: agent-error-log-drain
tasks: [T14399]
kind: fix
summary: "agent error history written before T14387 is no longer hidden: every open drains bare agent_error_log rows into tasks_agent_error_log"
---

Since T14387 the agent registry reads only `tasks_agent_error_log`, so rows in
the bare `agent_error_log` (every store's history before that change, and
whatever an older build still writes) were invisible to readers and to sync.

The twin collapse now drains the bare table into the twin at every open, as it
does for `token_usage` and `audit_log`. A row keeps its id when the twin has
that id free, lands once when the twin already holds the same row, and takes a
fresh twin id when the twin holds a different row under that id, since both
tables number rows from 1. `@cleocode/core/agents` no longer exports the bare
`agentInstances` and `agentErrorLog` tables.
