---
id: t13777-audit-collapse
tasks: [T13777]
kind: fix
summary: the dispatch audit moves into tasks_audit_log, which syncs; the bare audit_log is drained into it
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
successful one.

Rows waiting in a drained bare table (`token_usage`, `audit_log`) never count
as a legacy strand: the next open carries them.
