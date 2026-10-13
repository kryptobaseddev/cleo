---
id: t12940-session-status-terminal
tasks: [T12940]
kind: feat
summary: "Sync merges keep an ended or orphaned session ended unless it was resumed"
---

When two devices sync, a session that one device ended or orphaned now stays
ended, even if the other device wrote an ordinary status change later; only an
explicit `session resume` (or a switch to that session) reactivates it, and
the session's status and end time always travel together. The resume and
switch entry points name their command so other devices accept them.
