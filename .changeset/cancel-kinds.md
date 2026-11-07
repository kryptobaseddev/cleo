---
id: cancel-kinds
tasks: [T14267]
kind: feat
summary: "cleo cancel records why (--kind abandoned|superseded|duplicate|obsolete) and --replaced-by; a superseded or duplicate child whose replacement is done needs no waiver"
---

A cancelled child blocked its parent's rollup unless someone passed
`--waive-cancelled-children`, even when the work had moved to another task
that was already done. Owner decision D11229:

- `cleo cancel <id> --kind <kind> [--replaced-by <task>]` stores the kind and
  the replacement on the task (two new `tasks_tasks` columns,
  `cancellation_kind` and `replaced_by`, added by a forward-only migration).
  `--replaced-by` needs `--kind superseded` or `--kind duplicate` and an
  existing task. Re-running cancel on an already-cancelled task with a kind
  records it, so older cancellations can be marked without a restore.
- A child cancelled as `superseded` or `duplicate` whose replacement is
  `done` counts as covered in the epic rollup, in `cleo complete` and in
  `cleo done --plan`, through the one shared waiver decision. `abandoned`,
  `obsolete` and kind-less cancellations still need the waiver.
- `replaced_by` is a declared task reference, so it follows a display-id
  re-mint like `parent_id`. Restoring a task clears both fields.

Ledger: adds one enum field (and its replacement reference); deletes most
`--waive-cancelled-children` use.
