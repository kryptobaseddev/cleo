---
id: t13965-wait-deadline-external
tasks: [T13965]
kind: fix
summary: The first memory-pressure waiting line says when the wait gives up, and the named memory users leave out CLEO's own runs
---

The "waiting: memory pressure" line now ends with "gives up in X" from the
first notice, not only in the one-minute holder report. The largest memory
users a wait names now leave out CLEO's own runs (a ledger holder's pid, its
tool process groups, and the waiting process), so the list shows what else
took the memory.
