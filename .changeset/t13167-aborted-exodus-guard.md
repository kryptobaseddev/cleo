---
id: t13167-aborted-exodus-guard
tasks: [T13167]
kind: fix
summary: An aborted migration from the legacy stores can no longer strand their data
---

When exodus-on-open aborts (a parity failure, an assessment failure, a plan mismatch, or a
completion marker contradicted by legacy rows), the consolidated `cleo.db` stays empty while
the legacy rows wait. This is the same state a deferral leaves (T13158). Before, nothing
refused writes after an abort: `assertWriteDurable` had no production callers. A `cleo add`
or `cleo session start` then made the store look populated, and the legacy rows were
stranded.

- **An abort guards the store.** While legacy rows wait, the store the command gets refuses
  every INSERT into a table the migration fills, with `E_EXODUS_ABORT_WRITE_UNSAFE` and the
  remedy (`cleo doctor exodus-health`, then `cleo exodus migrate`). Readers get a
  `W_EXODUS_ABORTED` warning.
- **Unlike a deferral, a completion marker does not lift an abort.** A contradicted marker can
  be the cause of the abort. Only rows in the anchor table do, which a reconcile or a
  migration in any process provides.
- **The typed check runs on the production write paths:** the task accessor's write
  transaction (`cleo add`, `cleo update`, …), session creation (`cleo session start`), and
  `insertIdempotent` / `upsertIdempotent`. Refusals keep their code and remedy through the
  task and session error converters, instead of becoming `E_INTERNAL` or "Task database not
  initialized".
- `ExodusAbortWriteUnsafeError` moves to `store/exodus/abort-events.ts`, a light module the
  error converters can import. It is still exported from `@cleocode/core`'s store and db
  entry points. The guard module is now `store/exodus/write-guard.ts` and covers both kinds.
