---
id: cancel-restore-mutation-envelope
tasks: [T14220]
kind: fix
summary: "cleo cancel and cleo restore return the standard mutation envelope, so --field /data/updated/0 resolves on both"
---

`cleo cancel` returned its own shape, so `--field /data/updated/0` failed with
`E_FIELD_NOT_FOUND` even when the cancel succeeded. Cancel and restore now
project like update and complete:

- `cleo cancel` lists the cancelled task first in `updated[]`, then every
  child a cascade cancelled. `count` covers them all.
- `cleo restore` lists every task it restored in `updated[]`, or the task
  itself when reopening a done task.
- The fields scripts already read stay alongside: `task`, `cancelled`,
  `reason`, `cancelledAt`, `childStrategy`, `affectedTasks`, `affectedCount`,
  `previousStatus`, `newStatus`.
- The CLI output contract (CLEO-INJECTION.md, ct-cleo 2.25.6) lists cancel and
  restore among the mutations.
