---
id: t13857-local-audit-scrub
tasks: [T13857, T13863, T13864]
kind: fix
summary: "store open scrubs secrets written to audit rows before T13855, once per store, with capture suspended so nothing syncs; legacy audit_log rows drained later land redacted; Authorization: Basic credentials are redacted with the label kept"
---
