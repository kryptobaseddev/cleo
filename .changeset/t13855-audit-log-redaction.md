---
id: t13855-audit-log-redaction
tasks: [T13855, T13859, T13860, T13861]
kind: fix
summary: "audit tables scrub secrets on write, local and pulled: secret-named params, a `value` whose sibling `key`/`name` names a secret, credential shapes, `Authorization: token`, URL passwords and `--token` flags become [REDACTED] in tasks_audit_log, audit_log and nexus_audit_log; path-shaped text such as `process.env` or `.env.example` is kept, and a re-delivered redacted row is no conflict"
---
