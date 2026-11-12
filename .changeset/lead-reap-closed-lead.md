---
id: lead-reap-closed-lead
tasks: [T14513]
kind: fix
summary: "Report a closed lead's dead record on the next orchestrate lead and keep its already-ended session untouched."
---

`cleo orchestrate lead` now reports a dead lead record it removed before starting under `data.lead.reaped` (epic, pids, session, what was released). The reaper no longer re-ends a lead session that had already ended, so the session keeps its own end time and notes.
