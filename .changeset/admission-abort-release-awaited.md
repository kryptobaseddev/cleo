---
id: admission-abort-release-awaited
tasks: [T14495]
kind: fix
summary: "an aborted admission removes its queue entry before admit() returns, so no ledger writer outlives the call"
---

`admit()` removed an aborted waiter from the ledger in a fire-and-forget
`void releaseLedgerEntry(...)` inside its `finally`. The removal reads the
ledger, takes the critical section, writes the file by tmp + rename and
releases the lock, so `admit()` could return while that write was still
pending. A caller that then removed the ledger directory — a test tearing down
its tmpdir — raced the write: the background pass either wrote into a directory
being deleted (`ENOTEMPTY`) or recreated it (`mkdirSync`) after the deletion and
left a stray ledger behind.

The release attempt is now awaited. It stays bounded: on the abort path the
first attempt waits at most `RELEASE_AWAITED_MS` (250 ms) for the ledger lock,
so an abort or deadline that was already enqueued returns promptly even when
another process holds or stalls the lock (the lock itself retries for about
15 s). A timed-out attempt hands the entry to the existing background retry,
which keeps trying until it is retired, so no queue entry is stranded. On the
normal path the entry is written out and the lock released before `admit()`
returns, so nothing writes into the ledger directory after the refusal is
handed back.

The abort test now asserts the removal has already happened at return instead
of waiting for it, a new test proves an aborted admit returns within the bound
against a stalled lock and that the retry retires the entry, and the whole
`admission-ledger.test.ts` passes 50 consecutive runs with no `ENOTEMPTY`.
