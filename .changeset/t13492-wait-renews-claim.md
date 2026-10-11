---
id: t13492-wait-renews-claim
tasks: [T13492]
kind: fix
summary: "A queued cleo run --wait or cleo verify keeps its own session's task claims alive"
---
A claim lease (30 minutes) is renewed by its holder's mutations. A heavy run queued behind other runs makes none, so on a busy machine the waiter's own lease expired mid-wait (axiom T1796) and another agent could take the task.

The admission wait loop now calls a keep-alive when it enters the queue and every 5 minutes after. Both governed paths (`cleo run --wait` and evidence runs from `cleo verify`) renew the leases held by the invoking session's own bound session: connection, `CLEO_SESSION_ID` or terminal binding, never the newest-active fallback.

A renewal only extends leases that session already holds and are still live, so a foreign holder's claim is never touched and an expired lease is never revived. A failed renewal never fails or delays the run. `cleo claim <id> --renew` remains the explicit surface.
