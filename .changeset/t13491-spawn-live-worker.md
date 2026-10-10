---
id: t13491-spawn-live-worker
tasks: [T13491]
kind: fix
summary: "orchestrate spawn refuses with a hand-off instead of handing a child the session a live worker is using"
---
A re-spawn reuses the task's per-agent session. When a worker was already running under that session (axiom T1544), the spawn still succeeded and emitted a prompt bound to it, so a second agent shared the worker's session.

Spawn now refuses with `E_TASK_CLAIMED` when the reused session holds a live lease on the task and has done work since it took that lease. The refusal names the holder session, its agent, the lease expiry and its last activity, and gives a hand-off: coordinate with the worker, or end its session once it has stopped with `cleo session end --session <id>`, which releases its claim and worktree lock.

The holder stops counting as live only through the existing rules. Ending the session gives the next spawn a fresh session (T13425). A lease its worker stopped renewing expires, and the next spawn then reuses the session, audited as `spawn_session_reclaim`. A session no worker has used yet, for example when an orchestrator asks for the same prompt again, is reused as before.
