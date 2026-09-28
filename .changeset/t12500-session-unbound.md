---
id: t12500-session-unbound
tasks: [T12500]
kind: fix
summary: an unbound terminal can no longer end, attribute to or suspend another agent's session; new E_SESSION_UNBOUND (exit 24)
---

Session resolution ended in a newest-active-row fallback, so a terminal that
never ran `cleo session start` resolved whichever agent wrote the database last:
`cleo session end` from that terminal ended ANOTHER agent's session, and
decisions, assumptions, audit rows, completion stamps, override-cap charges,
safestop, `session switch` and epic-scope parent inference all acted on it.

Mutations and attribution now resolve only the caller's BOUND session
(daemon connection handle, `CLEO_SESSION_ID` naming a real row, or the terminal
binding written by `session start` / `session resume` / `session switch`). An
unbound caller gets `E_SESSION_UNBOUND` (exit 24, `ExitCode.SESSION_UNBOUND`)
while any session is active, with the ways to bind: `cleo session start`,
`cleo session resume <id>`, `CLEO_SESSION_ID=<id>`, or naming the target
explicitly (`cleo session end --session <id>`, whose flag was previously
accepted and ignored). With no active session the existing
`E_SESSION_NOT_FOUND` / `'default'` behaviour is unchanged. Attribution-only
paths (audit, completion stamp, memory telemetry, pivot) record no session
rather than refusing.

Read-only `session status` and `briefing` may still show the newest session to
an unbound caller, labelled `unbound: true`.

Spawn no longer falls back to the orchestrator's session when allocating the
child's own session fails; the spawn is refused with `E_SESSION_UNBOUND`.
Gate 16 (`lint-no-bare-get-active-session`) baseline lowered 11 → 0.
