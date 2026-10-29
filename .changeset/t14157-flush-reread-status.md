---
id: t14157-flush-reread-status
tasks: [T14157]
kind: fix
summary: "a session ended inside a rolled-back savepoint no longer gives back its agent-session lease when the outer transaction commits"
---

After an outer COMMIT, the lease flush (T14151) now re-reads each pending
session's committed status. It releases only sessions whose row is `ended`,
`orphaned` or `abandoned`. A session that an inner savepoint ended and then
rolled back keeps its lease, so no extra agent is admitted. A read that fails
keeps every lease. The bulk path still reads the lease directory once.
