---
id: saga-reconcile-typed-receipt
tasks: [T12457, T12292]
kind: fix
summary: saga reconcile now enforces typed completion criteria and writes a transactional saga_reconciled receipt
---

`cleo saga reconcile` could close a saga whose own typed acceptance criteria
were unproven: it flipped `status='done'` with a plain upsert, outside any
transaction, and left no row in `tasks_audit_log`. That is the one closure path
that bypassed the typed-completion rule `completeTask` already enforces for the
same saga.

A real closure now re-reads the saga and its members after `BEGIN IMMEDIATE`,
validates typed completion against the transaction's criteria rows and the
canonical `gate.verify.typed` receipts, preserves the saga's authentic
`gateResults`, and writes the saga row together with a `saga_reconciled`
receipt in one write transaction — a failed receipt write rolls the closure
back. `pipelineStage` is only moved to `contribution` when it is not already
terminal, matching `completeTask`.

A dry run performs the same drift and typed-completion checks without opening a
write transaction, so a preview never takes the tasks DB write lock; a saga
with unmet typed proof previews as `action: 'error'`. A cancelled or expired
caller execution lifetime rejects the call instead of being renewed.

The `.cleo/audit/saga-reconcile.jsonl` decision log is kept (it is exported as
`SAGA_RECONCILE_AUDIT_FILE` and documents no-op/blocked/error decisions the DB
receipt does not cover); the DB receipt is the authoritative closure record.
