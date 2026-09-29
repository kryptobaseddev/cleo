---
id: t12502-leased-task-claims
tasks: [T12502]
kind: feat
summary: leased task claims — cleo start and spawn take a session lease; a second session gets E_TASK_CLAIMED naming the holder
---

`cleo start <id>` now takes a time-limited claim lease on the task for the
caller's bound session, with a compare-and-set in the same write transaction as
the start. A second session starting the same task is refused with
`E_TASK_CLAIMED` (exit 35); nothing is written, and `error.details` names the
holder (`sessionId`, `agentId`, `claimedAt`, `leaseExpiresAt`), whether the
lease has `expired`, and the one override that applies. Spawn claims the task
for the spawned agent's session, taking it over from the orchestrator's own
session when that session held it (audited as a hand-off); a foreign holder
refuses the spawn.

Leases last 30 minutes (`CLEO_CLAIM_LEASE_MINUTES` overrides) and are renewed by
every successful mutation the holder session makes, or by
`cleo claim <id> --renew`. `cleo stop`, `cleo unclaim`, starting another task,
completing, cancelling or archiving the task, and the holder session ending (or
being deleted) release them. An expired lease is never taken silently:
`cleo start <id> --take-over` (or `cleo claim <id> --take-over`) takes it, and
`--force-claim` overrides a live one. Both are recorded in the task audit log.

The claim is separate from the human assignee: `cleo start`, `cleo claim` and
spawn no longer write `assignee`, and `cleo unclaim` no longer clears it. `cleo
claim --agent` is optional (defaults to the session's agent). `cleo show`
carries the lease at `/data/task/claim` (withheld by the default projection;
`--field /data/task/claim` or `--full` returns it). The LAFS code for exit 35 is now
`E_TASK_CLAIMED` (was `E_CLEO_TASK_CLAIMED`, never emitted before).

Schema: additive migration `20260929120000_t12502-task-claim-leases` adds four
NULL-able columns to `tasks_tasks` (`claimed_by_session`, `claimed_by_agent`,
`claimed_at`, `lease_expires_at`, classified `local-only`), an index, and the
release triggers. Unbound callers take no lease and behave as before on
unclaimed tasks.
