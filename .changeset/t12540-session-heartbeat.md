---
id: t12540-session-heartbeat
tasks: [T12540, T12500]
kind: fix
summary: a working session's lastActivity is refreshed on every bound mutation (at most once a minute), so liveness and session gc stop orphaning long-running sessions
---

`sessions.last_activity` was written only by `session start`, so every
liveness check and `session gc` measured a session's age from when it STARTED.
An agent that kept working for more than a day looked abandoned.

Every successful mutation by a bound session now runs one heartbeat through the
existing claim-heartbeat middleware: it refreshes `lastActivity` at most once
per minute (a primary-key read decides, so a throttled beat takes no write
lock), then renews the session's claim leases. The write uses a 50 ms
`busy_timeout` and is skipped on `SQLITE_BUSY` — the same bound the lease
renewal already had, now one shared helper.

`session gc` measures idleness from `lastActivity` (else `startedAt`), and the
CLI's `session gc` now runs the core gc, so it also keeps a session that holds a
live claim lease. An orphaned session is marked `orphaned` (it was `ended`).

T12500 follow-up: the last four read-only surfaces that picked an active row
inline now resolve the caller's session through `resolveSessionForRead` and
label an unbound guess (`session.unbound` in the bootstrap brain state, an
`unbound` note in the generated injection); the bare-`getActiveSession` gate's
baseline is 0. `E_SESSION_UNBOUND` fix hints name the copy-paste form
`cleo session start --scope global --name "<name>"`.
