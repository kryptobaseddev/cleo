---
id: t12239-brain-writer-teardown
tasks: [T12239]
kind: fix
summary: Mutating commands no longer pay 3 seconds to "event loop still alive after teardown"
---

**gh#1448, gh#1454, gh#1457, gh#1466.** Two independent causes of the same
symptom.

**1. The writer rebuilds itself after being shut down.**
`shutdownBrainWriter()` sets `_manager = null`, discarding that manager's
`shuttingDown` flag with it. A write arriving afterwards hits `if (!_manager)
_manager = new BrainWriterManager()` and gets a fresh manager whose flag is
`false` — so `ensureWorker()`'s guard passes and a worker realm is spawned
**after** teardown, its MessagePort holding the loop open until the backstop.

Guarded at **acquisition**, with a module-scope latch — module scope precisely
because the manager that would otherwise hold the flag is the thing being
discarded. There is exactly one acquisition site and it terminates; work-START
sites are an open set, which is why the earlier T12217 attempt could not
converge. The latch is set before the first `await`, because
`_manager.shutdown()` waits out a grace period and a write landing inside that
window must be refused too.

A second defect closed by the same guard, not on the ticket: that block
registers `process.on('exit')` plus two `process.once` handlers **every** time
it runs, so each teardown → late-write cycle leaked three process-lifetime
listeners.

The write is not lost — it routes to `runInline` as before, now logged at
**warn** (`event: post-teardown-inline-write`) because "no worker file in a
bundle" is normal and belongs at debug, while "a write arrived after teardown"
should be countable in the field.

**2. The dialectic hook outlives the backstop by seven seconds.**
`DIALECTIC_DEADLINE_MS` is 10s; `EXIT_BACKSTOP_MS` is 3s. **Unrefing the timer
does not unref the socket** — a dialectic in flight at teardown holds a
`TCPSocketWrap` past the point the warning has already printed. The CLI adapter
builds this Dispatcher, so `add-batch`, `verify`, `complete` and `relates add`
all route through it: exactly gh#1466's list.

New `teardown-signal.ts` — three functions, no more —
`markShuttingDown`/`isShuttingDown`/`registerTeardownAbort`, called as step 0 of
`shutdownCliRuntime` so in-flight work is cancelled while the resources it might
touch are still valid. Registering *after* teardown aborts immediately, closing
the race where work starts between the latch flipping and the controller being
handed over.

**The abandoned WIP is tombstoned, not deleted** — annotated tag
`tombstone/T12217` records why it cannot work and the two premises measurement
falsified (git children *are* fully reaped: 94 spawns, 0 never-exited; its
suppression is *inert* on `cleo memory observe`). Its
`trackBackgroundWork`/`drainBackgroundWork` are deliberately not reproduced: a
registry that tries to *enumerate* in-flight work is the approach that failed.

**On the tests.** They assert on **process listener counts**, not "was a Worker
constructed". `resolveWorkerPath()` looks for a file that does not exist under
vitest, so everything falls inline and a "no Worker" assertion **would pass
against the broken code** — a restatement of the harness, not a regression test.
Predicted 4 failures against the unfixed source and got exactly 4, with the one
designed to be green-in-both staying green (it proves the late write is not
silently dropped).

**Not claimed:** that the 3-second penalty is gone end to end. That needs an
absence-of-string check over N runs of each affected command, in CI or on a
`/home` clone — no timing taken on the `/mnt` fuseblk checkout is evidence about
code.
