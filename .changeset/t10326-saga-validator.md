---
id: t10326-saga-validator
tasks: [T10326]
kind: fix
summary: "validateTaskType accepts 'saga' (closes T10326 dogfood AC6 gap)"
---

Hotfix following SAGA T10326 SG-SUBSTRATE-RECONCILIATION ship (v2026.5.113):
`packages/core/src/tasks/add.ts:276` had a hardcoded valid TaskType list
`['epic', 'task', 'subtask']` that didn't include `'saga'`. This caused
`cleo add --type saga` to reject with `Invalid task type: saga` despite the
contract widening + DB enum widening that shipped under T10328 / T10329.

Unblocks the AC6 dogfood requirement that `cleo add --type saga` works
without label fallback.
