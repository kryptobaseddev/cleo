---
id: typed-gate-text-acceptance-refused
tasks: [T12292]
kind: fix
summary: "Text acceptance now refuses a typed gate object instead of storing it as prose"
---

`cleo add --acceptance '{"kind":"test",...}'` (and `cleo update`, `cleo saga create`)
used to succeed and store the gate JSON as one literal criterion, dropping its gate
meaning without a word. Text acceptance now refuses a whole JSON object with a string
`kind`, whether it is the entire input, one pipe-separated token or a JSON array
entry. The refusal, and the existing nonstring-entry refusal, carry a fix naming
`cleo req add <taskId> --gate '<gate-json>'`. Prose with braces, pipes and quoted
unions is unchanged (T12197).
