---
id: durable-worker-records
tasks: [T14359]
kind: fix
summary: "Detached workers get a durable store record; SubagentStop fires once when the worker exits, not at spawn"
---

`orchestrateSpawnExecute` dispatched `SubagentStop` the moment a detached
spawn returned, while the worker was still running, and the claude-code
adapter's process map lived only in the CLI process that spawned it.

A worker the adapter leaves running now gets a row in the local-only
`tasks_agent_instances` table (task, adapter instance id, pid/pgid, worktree,
lead mailbox, provider, start time, session). `reconcileWorkerExits` probes
each open record's pid and closes an exited worker with a compare-and-set on
`stopped_at`, so exactly one caller dispatches `SubagentStop`. `cleo
orchestrate status` runs the reconcile and lists the records under `workers`.
Spawns that already ended still emit `SubagentStop` at once.

The adapter registry now passes the provider's `ownership` handle through,
and a still-running worker is no longer auto-integrated at spawn (the adapter
reported a placeholder exit code of 0). Fan-out dispatch moved from the CLI
into core `dispatchWorkers`; the CLI handler only keeps the fanout-status
manifest.
