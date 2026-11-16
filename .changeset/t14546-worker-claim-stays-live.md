---
id: t14546-worker-claim-stays-live
tasks: [T14546]
kind: fix
summary: "A worker's task claim stays live while the worker is, and a worker renews its own expired claim with cleo claim --renew"
---
A claim lease (30 minutes) was renewed only by its holder's mutations. A spawned worker that edited files, ran git, watched CI or waited on a review round made none, so its lease lapsed mid-task; the spawn prompt then told it to stop and return to the coordinator, who re-took the claim by hand with a resume spawn.

- The heavy-command hook, which already runs before every shell command, now renews the leases of the session its own process is bound to: a `CLEO_SESSION_ID` in the hook's environment, else the task worktree it runs in, through the worktree lock spawn wrote. It never reads an identity from the command line, and it renews only while that session holds the claim. A stamp file limits it to one store open per identity every five minutes.
- A bound session's read renews its lease too, before the read runs, once half the lease is gone. A resuming worker reads its claim as live.
- Both paths extend only leases the session still holds, only for an active session, and skip a store whose task writes are blocked. A process bound to another session cannot extend this one's lease, so an idle holder's claim still lapses and can be taken over.
- `cleo claim <id> --renew` revives the caller's own expired lease while no other session has claimed the task. When another session has, the refusal now says the claim is no longer the caller's, names the holder and tells the worker to hand off; it no longer suggests `--take-over`.
- The spawn prompt, the shared subagent protocol, `ct-orchestrator` and `ct-task-executor` name the renewal instead of "return blocked".

Not changed: a lease still lapses when its worker runs nothing at all for a full lease length. The first command the worker runs afterwards revives it unless another session took the task over in between.
