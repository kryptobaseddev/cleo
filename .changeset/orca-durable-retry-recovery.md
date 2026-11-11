---
id: orca-durable-retry-recovery
tasks: [T14455]
kind: feat
summary: "Orca execution: replay exact requests and reserve durable retries"
---

Replay original launch and stop requests and atomically reserve retries on the same Task, Run and canonical workspace.

Retain unknown outcomes and circuit-breaker history across restarts. Require an exact exited, released predecessor before admitting its successor, preserving task claims and dirty worktrees. Automatic backend routing and harness rotation remain separate work.
