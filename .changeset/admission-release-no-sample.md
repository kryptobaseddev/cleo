---
id: admission-release-no-sample
tasks: [T14508]
kind: fix
summary: "an admission release hands its slot on without waiting for a pressure sample, and an aborted lock is unlocked before the caller moves on"
---

A normal release used to sample memory pressure inside its 250 ms bound. Under
memory pressure a slow sample pushed the freed slot to the 1 s retry or to the
reaper after the CLI exited, so waiters saw it late. Release now removes the
entry and schedules the queue with the last pressure verdict in the ledger;
each waiter's own pass still samples afresh.

A ledger lock acquired and then aborted is now unlocked before the lock call
rejects, instead of in the background, so the caller's own deadline bounds the
unlock and it no longer outlives the caller.
