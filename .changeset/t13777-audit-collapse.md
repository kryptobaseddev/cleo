---
id: t13777-audit-collapse
tasks: [T13777]
kind: fix
summary: the dispatch audit moves into tasks_audit_log, which syncs; the audit prune now deletes old task history on every device, keeping receipts, with a 30-day floor
---

Every command writes an audit row. The dispatch audit went to the bare
`audit_log` and the task-mutation audit to `tasks_audit_log`, and neither
travelled in the change journal, so a journal checkpoint could not account
for their rows on any real store.

The dispatch audit (and the release backfill audit) now write
`tasks_audit_log`, every `schema.auditLog` reader reads it, and the twin
collapse drains the bare `audit_log` into it at every open, losslessly, the
way `token_usage` drains: a row keeps its id, so its row uid. The twin is
declared natural on `id` and syncs.

A dispatch request's idempotency key now lives in `dispatch_idempotency_key`,
outside the twin's UNIQUE(project_hash, domain, operation, idempotency_key):
a failed attempt and its retry record two rows under one key, which that
constraint would refuse, and the idempotent replay reads the newest
successful one. A row exodus carried over keeps its key in `idempotency_key`
and still replays.

The audit prune (`logging.auditRetentionDays`, default 90) now covers the
task-mutation history too (add, update, complete, gate.set and the rest),
and because `tasks_audit_log` syncs, its deletes reach every device. The
task rows keep the current state and evidence. Receipts code reads back are
kept whatever their age: `ac.bindings.pruned`, `saga_reconciled`,
`ranking_changed`, and `gate.verify.typed` while its task is neither done
nor cancelled. A retention below 30 days is raised to 30, so one device or
agent cannot erase the fleet's recent history. The archive written before a
prune (`archiveBeforePrune`) stays on the device that pruned.

Rows waiting in a drained bare table (`token_usage`, `audit_log`) never count
as a legacy strand: the next open carries them.
