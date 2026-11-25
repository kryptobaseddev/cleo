---
id: typed-gate-text-acceptance-refused
tasks: [T12292]
kind: fix
summary: "Text acceptance now refuses a typed gate object instead of storing it as prose"
---

`cleo add --acceptance '{"kind":"test",...}'` used to succeed and store the gate
JSON as one literal criterion, dropping its gate meaning without a word; so did
`cleo update`, `cleo add-batch`, `cleo saga create` and dispatch `tasks.add` /
`tasks.update` with array params. The shared acceptance-input boundary now refuses
a criterion that is a whole JSON object whose `kind` is a gate kind, with a fix
naming `cleo req add <taskId> --gate '<gate-json>'`. Prose with braces, pipes and
quoted unions, and JSON objects with any other `kind`, stay literal (T12197).
Stored criteria are never re-normalized.
