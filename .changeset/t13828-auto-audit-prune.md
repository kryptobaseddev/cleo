---
id: t13828-auto-audit-prune
tasks: [T13828]
kind: fix
summary: the audit retention prune now runs by itself at session end, at most once a day per project
---

The audit retention prune (`logging.auditRetentionDays`) ran only when someone
ran `cleo admin cleanup --target logs`, so old audit rows were never pruned on
their own. Session end now runs it after its snapshot, at most once a day per
project. It keeps the same retention days, the 30-day floor and the receipts it
never deletes. `cleo admin cleanup --target logs` still prunes on demand.
