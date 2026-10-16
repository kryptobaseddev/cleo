---
id: t13777-command-logs-journal
tasks: [T13777]
kind: fix
summary: token usage, session handoffs and the Nexus audit log travel in the change journal; Nexus device and location rows stay on their machine
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
once the table synced.

`nexus_devices` and `nexus_project_locations` are local-only. The cloud holds
device presence and where projects live (/v1/status); a machine's own view and
its paths never replicate.

Portable tables the journal does not carry yet are named in a journal
checkpoint's signed `snapshotAuthoritative` list, which the server's row rule
skips (cleo-nexus #45). The list only shrinks along a lineage and is sent only
to a server whose E3 status lists `manifest.snapshot-authoritative`; against
an older server a push whose exempt tables changed is refused with that cause.
`cleo cloud verify` compares those tables with the head snapshot, not with
the journal's tallies.
