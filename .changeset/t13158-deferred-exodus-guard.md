---
id: t13158-deferred-exodus-guard
tasks: [T13158]
kind: fix
summary: A deferred migration from the legacy stores can no longer strand their data
---

Opening a store whose legacy `tasks.db` / `brain.db` / `nexus.db` still hold rows runs the
migration into `cleo.db` (exodus-on-open), admitted through the machine-wide `db-heavy` slot.
When admission failed, the open skipped the migration and returned the EMPTY store. This
happened under memory pressure, and whenever the slot was busy: a sentient tick, a
`cleo run --class db` job, another project's migration, or two `cleo` commands racing the
first open. The first write then made the store look populated, so no later open migrated
it. The legacy rows stayed stranded until a manual reconcile.

- **The open now decides first whether a migration is pending.** For a migrated store this
  costs one `COUNT(*)`, and only a pending migration asks for admission. It waits up to 5 s
  for the slot (`CLEO_EXODUS_ADMISSION_WAIT_MS`). Memory pressure still defers at once.
  Opens that need no migration no longer touch the governor at all.
- **A migration still deferred guards the store.** While legacy rows wait, every INSERT into
  a table the migration fills is refused with `E_EXODUS_DEFERRED_WRITE_UNSAFE` and the
  remedy. The guard is a connection-local temp trigger, so it is never persisted. Task
  writes refuse with the typed `ExodusAbortWriteUnsafeError` (`codeName`
  `E_EXODUS_DEFERRED_WRITE_UNSAFE`), and so do `assertWriteDurable`, `insertIdempotent` and
  `upsertIdempotent`. Reads work, and their envelopes carry a `W_EXODUS_DEFERRED` warning.
  The next admitted open migrates every row.
- The governor's budget-0 deferral reason now names the signal the budget used: memory
  alone under `ignoreCpuPressure`, else the combined score. The deferral log carries the
  governor's own reason.
