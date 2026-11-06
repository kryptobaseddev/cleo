---
id: settled-child-predicate
tasks: [T14266, T14217, T14223]
kind: fix
summary: "cancel, complete and done share one settled-child predicate and one cancelled-child waiver guard, and a cancel cascade commits atomically"
---

`isSettledChild` (done, cancelled or archived) in contracts is now the one
answer to "is this child finished?". `cleo cancel` no longer refuses a parent
whose children are all settled, its cascade touches and counts only unsettled
descendants and never refuses a done one, and `complete`'s premature-close
guard no longer counts an archived child as pending. `cleo complete` and
`cleo done` share one cancelled-child waiver guard, so
`cleo done <epic> --waive-cancelled-children "<reason>"` closes an epic with a
cancelled child. The cancel cascade and reparent writes run in one
transaction with the parent, and a failed store write reports its SQLite
cause in a bounded message instead of the full SQL echo.
