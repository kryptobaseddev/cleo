---
id: t13855-audit-log-redaction
tasks: [T13855]
kind: fix
summary: "audit tables scrub secrets on write: `service connect --token` and any other secret-named param or credential-shaped value is stored as [REDACTED] in tasks_audit_log (which syncs) and nexus_audit_log"
---
