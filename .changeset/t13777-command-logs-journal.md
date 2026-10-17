---
id: t13777-command-logs-journal
tasks: [T13777]
kind: fix
summary: token usage, session handoffs and the Nexus audit log travel in the change journal
---

Every command writes token usage, and every session end writes a handoff
entry. Both tables are portable, so every vault snapshot lists them, but
neither had row identity, so the change journal never carried them. A journal
checkpoint could not account for their rows, and `cleo cloud push` refused on
every real store (T12999 on staging).

`tasks_token_usage` and `tasks_session_handoff_entries` (project) and
`nexus_audit_log` (global) now have row uids and sync. Token usage and the
audit log are natural over their UUID ids, and a handoff over the session it
belongs to. The handoff's write-once guard now covers its content columns
only: before, it aborted the uid fill, so a session end would have failed
once the table synced. The table's DDL has no UNIQUE on the session, so a
second handoff for a session is now refused before it is written, and on a
store that already holds one, the first row (earliest `created_at`, then
lowest id) takes the uid while a later row stays on its device: it is never
captured and never holds the fill pending.

Portable tables the journal does not carry yet are named in a journal
checkpoint's signed `snapshotAuthoritative` list, which the server's row rule
skips (cleo-nexus #45). The list only shrinks along a lineage and is sent only
to a server whose E3 status lists `manifest.snapshot-authoritative`; against
an older server a push whose exempt tables changed is refused with that cause.
`cleo cloud verify` compares those tables with the head snapshot, not with
the journal's tallies.

All devices on a stream must be on this client once one sends the list: a
push from an older cleo omits it and the server refuses it
(`authoritative-omitted`); the refusal names that cause and says to upgrade
cleo on the other devices. A portable table that is neither journaled nor
listed can never join the list later, so a new portable table is journaled
from its first release (T13801).

Rows waiting in the drained bare `token_usage` never count as a legacy
strand: `tasks_token_usage` now syncs, and the next open carries them.
