---
id: t12711-archive-reason-map
tasks: [T12711]
kind: fix
summary: exodus maps each legacy archive_reason to its member, keeps the legacy value, and never hides a failed verify
---

Exodus now maps legacy `tasks.archive_reason` values to the member that says the same thing instead of collapsing all of them to `completed-unverified`: `completed` → `completed-unverified`; `deleted`, `orphan-cleanup`, `synthetic-test-artifact` → `cancelled`; `recovered` → `reconciled` (any other value still takes the tombstone). The enum is not widened. Every row whose enum value a copy maps keeps its legacy value, keyed by the row, in the store's `_exodus_recovery_value_map` (removed with the copy on rollback). `verifyMigration` judges enum drift on the value the copy lands, so a mapped legacy value is no longer reported as FAILED; a value no rule maps still is. When the cutover proceeds despite a failed verify (a digest mismatch), the findings are recorded in the completion marker and shown by `cleo doctor exodus-health` and `cleo exodus migrate`.
