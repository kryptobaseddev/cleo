---
id: t13889-queue-admission-deadline
tasks: [T13889]
kind: fix
summary: "Bound cleo run queue admission across pending sampling and ledger locks"
---

`cleo run --wait` now applies its queue deadline before the initial resource
sample and rejects late ledger or database-slot grants. Ledger admission also
stops pending sampling and lock waits at its deadline or cancellation, and late
operations cannot enqueue a new reservation or launch the command. A late
ledger I/O failure cannot bypass an expired positive deadline.

Abandoned entries use the existing removal retries. A deferral does not prove
that a row was removed while storage is unavailable; cleanup continues when
storage recovers, with dead-runner reaping as a recovery path. Cleanup retries
unreadable or malformed state without treating it as an empty ledger. An admitted
child keeps its existing watchdog and may run beyond the queue deadline.

Nonblocking Vitest project discovery now explicitly requests a zero-budget
admission pass instead of a one-millisecond queue budget. The one-pass form
still samples and acquires asynchronously, without queue polling.

Timer-driven deferrals retain the last reported waiting-pressure reading and
its memory remedy, clearing it when admission reports that pressure fell.
