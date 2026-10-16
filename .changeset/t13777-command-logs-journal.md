---
id: t13777-command-logs-journal
tasks: [T13777]
kind: fix
summary: token usage, session handoffs and the Nexus audit log travel in the change journal; Nexus device, location and registry rows stay on their machine
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

`nexus_devices`, `nexus_project_locations` and `nexus_project_registry` are
local-only. The cloud holds device presence, where projects live and the
project list, and a project's display name travels in its git-tracked
`.cleo/project.json`.
