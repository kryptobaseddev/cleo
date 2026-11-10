---
id: durable-worker-records
tasks: [T14359]
kind: fix
summary: "Behind orchestrate.leadWorker.v1, detached workers get a durable record and SubagentStop fires once when the worker exits, not at spawn"
---

With `orchestrate.leadWorker.v1` on (default off), `orchestrateSpawnExecute`
writes a worker record to the local-only `tasks_agent_instances` table
BEFORE the adapter spawns (task, a pre-assigned instance id, pid/pgid once
known, worktree, lead mailbox, provider, start time, session), so a worker
that dies at once still finds its record.

Completion is an event: the worker runs `cleo orchestrate worker-exit` as
its session ends (the claude-code adapter adopts the pre-assigned id and
passes the worker a `SessionEnd` hook via `--settings`). Without `--status`
the status comes from the task: `complete` only for a done task, so an auth
error, max turns or a crash with the task still active reports `partial`.
For a worker that crashed before its hook ran, `reconcileWorkerExits` probes
each open record's pid. Both paths close the record with a compare-and-set
on `stopped_at`, so exactly one caller dispatches `SubagentStop`.
A worker the adapter reports running with neither the exit hook nor a pid
fails closed: `SubagentStop` fires at spawn, as before. A tracked worker is
not auto-integrated at spawn (its exit code is a placeholder).
`cleo orchestrate status` runs the reconcile and lists the records under
`workers`.

With the flag off, spawn behaves as before. In both modes the adapter
registry passes the provider's `ownership` handle through, and fan-out
dispatch moved from the CLI into core `dispatchWorkers`.
