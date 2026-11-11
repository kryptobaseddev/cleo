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

The release attempt is now awaited. It stays bounded: `releaseLedgerEntry`
performs one attempt and only keeps retrying on its unref'd timer when the
ledger is genuinely unavailable, which is the case that must not strand a
queue entry. On the abort path the entry is written out and the lock released
before `admit()` returns, so nothing writes into the ledger directory after the
refusal is handed back.

The abort test now asserts the removal has already happened at return instead
of waiting for it, and the T13914 external-pressure test passes 50 consecutive
runs of the single file with no `ENOTEMPTY`.
