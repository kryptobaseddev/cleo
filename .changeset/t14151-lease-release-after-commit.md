---
id: t14151-lease-release-after-commit
tasks: [T14151]
kind: fix
summary: "a spawned session's agent-session lease is now released after its end commits, kept through a rollback or a suspend, and released before cleo session end returns"
---

Follow-ups from the review of #2594 (T14133).

- The release runs after the session's status write commits. Inside a write
  transaction the ended session is held until COMMIT, and a ROLLBACK keeps
  its lease. Nothing is awaited inside the transaction.
- A `suspended` session keeps its lease, since it resumes. Only `ended`,
  `orphaned` and `abandoned` release it.
- A bulk session save that ends many sessions reads the lease directory once.
- `cleo session end` awaits the release, so the lease is gone when the
  command returns. A fire-and-forget release could be lost if the CLI exited
  first, holding the slot until its TTL.
