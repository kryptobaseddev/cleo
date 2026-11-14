---
id: t14553-bounded-work-capture
tasks: [T14553]
kind: fix
summary: "Bound awaited work-capture hooks: a held brain writer lease now defers the observation to a durable spool within a 2 s response budget (reported as W_WORK_CAPTURE_DEFERRED) instead of holding the command up to 60 s, and routine global and derived backups no longer wait on a held writer."
---
