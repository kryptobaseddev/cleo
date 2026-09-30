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
Terminal bindings are split by kind: agent process (`CLAUDE_CODE_SESSION_ID`,
…), pane (`TMUX_PANE`, …) and tab (`TERM_SESSION_ID`, …, or ppid). A sibling
tmux pane never falls through to the tab, and two Claude Code instances that
each started a session stay isolated. A session a human started in a tab IS
adopted by Claude Code in that tab (also after a restart), because tab
bindings record `bound_by_provider` (new column, migration
`20260928000000_t12500-binding-provider-flag`); a Claude-started session can
be ended from the plain tab. CLI mutations that run with no bound session
print a one-line stderr warning. The `E_SESSION_CONFLICT` advice now leads
with `--agent <handle>` / `session resume <id>` and never suggests ending
another agent's session. Sticky-to-session-note conversion and the drift
watchdog use the bound session.

An agent that starts its own session never overwrites a human's live tab or
pane binding (only its own provider key moves), and an agent that merely
adopted a human's tab session may work in it but cannot end it without
`--session <id>` (`E_SESSION_UNBOUND`, `details.adopted: true`).

Upgrade note: rows written before this migration by the unreleased T12499
binder default to `bound_by_provider = 0` (human), even when an agent wrote
them. T12499 was never tagged, so only development databases carry such rows;
ending the session they name clears them.
The SDK `cleo.sessions.end()` / `endSession` and session snapshots resolve the
bound session too; `sessions.start()` / `resume()` bind. Observations auto-link
only to the bound session's task. A harness exporting a non-CLEO
`CLAUDE_SESSION_ID` still binds on start. Only sessions active within 24 h make
an unbound caller ambiguous. Spawn allocation failures report the real error.

Gate 16 (`lint-no-bare-get-active-session`) now also flags inline
newest-active selection; bare callsites 11 → 0, baseline 4 (read-only
displays).
