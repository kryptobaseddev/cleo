---
id: admission-release-no-sample
tasks: [T14508]
kind: fix
summary: "an admission release frees its slot without waiting for a pressure sample, never admits on a stale verdict, and an aborted lock is always unlocked"
---

A normal release used to sample memory pressure inside its 250 ms bound. Under
memory pressure a slow sample pushed the freed slot to the 1 s retry or to the
reaper after the CLI exited, so waiters saw it late. Release now removes the
entry at once without sampling. It schedules the queue only when the ledger's
last pressure verdict is still fresh; on a stale verdict it admits nobody, and
the waiters' next pass samples afresh and schedules.

A ledger lock acquired as its caller aborts is now always unlocked exactly
once: awaited before the lock call rejects when the lock won the race, and
released as soon as it settles when the abort won. Before, an abort landing
in a one-microtask gap left the lock held, locking peers out.
