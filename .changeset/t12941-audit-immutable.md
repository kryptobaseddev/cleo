---
id: t12941-audit-immutable
tasks: [T12941]
kind: feat
summary: "Sync merges refuse any edit to an audit row once it is written"
---

Audit log rows are a record of what happened, so syncing devices now treat
them as immutable: an incoming change to an audit row that already exists is
refused and recorded as a conflict, in whatever order the changes arrive. Re-
delivering the same row changes nothing. This covers both audit tables.
