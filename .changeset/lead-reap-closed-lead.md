---
id: lead-reap-closed-lead
tasks: [T14513]
kind: fix
summary: "Report a closed lead's dead record on the next orchestrate lead and keep its already-ended session untouched."
---

`cleo orchestrate lead` now reports a dead lead record it removed before starting under `data.lead.reaped` (epic, pids, session, what was released). The reaper no longer re-ends a lead session that had already ended, so the session keeps its own end time and notes. It removes a dead lead's record only with proof: every process gone (a live pid whose start time cannot be read counts as alive) and the session ended. Otherwise the record is kept, reported with the reason, and a new lead is refused with `E_LEAD_RECORD_KEPT`. The reap report also rides on a refused spawn (`error.details.reaped`) and on `cleo orchestrate status` (`data.reapedLeads`).
