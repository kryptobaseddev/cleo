---
id: t13171-exodus-guard-followups
tasks: [T13171]
kind: fix
summary: "The exodus write guard lifts per legacy source, so no table takes writes while its own copy is pending; a store no trigger can guard is still refused by the typed write checks; a deferral that ended in an abort refuses as the abort"
---

Follow-ups to the deferred-exodus guard (T13158, review of #1836):

- **Per-source lift.** The guard used to stop refusing every table once the scope's
  anchor table (`tasks_tasks`) had rows. Each legacy source is copied in its own
  transaction, so writes to tables another source fills (sessions, brain) were accepted
  while that source's copy could still be running. Now each guarded table waits for the
  sentinels of the sources that fill it (per source, the first table in copy order that
  has legacy rows); a sentinel holding rows means that source committed. The typed write
  checks lift only when every source has committed.
- **Never fail open.** When even the anchor table's trigger cannot be created, the guard
  is still registered for the typed write checks that every production write path calls
  first, so the store is never published as if it owed nothing.
- **An abort is named as an abort.** A connection guarded while its migration waited for
  admission (a handle concurrent opens received) kept saying `deferred` after that
  migration ran and aborted. A later recorded abort now supersedes the deferral: the
  handle's `exodusAbort` reports it, and the typed check re-arms the triggers so a refused
  write carries `E_EXODUS_ABORT_WRITE_UNSAFE` and the abort's remedy.
