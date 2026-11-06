---
id: diff-only-task-writes
tasks: [T14218, T14265]
kind: fix
summary: "Task writes update only changed columns, the guard triggers fire only on a real change, and a refused task write names its SQLite cause"
---

A task row that predated a guard (a task under a task, or a status and
pipeline stage pair from before T877) refused every later write, a notes edit
included, with a bare `E_INTERNAL`. Every upsert SET the whole row, and SQLite
fires `BEFORE UPDATE OF col` whenever `col` is in the SET list, even when its
value is unchanged.

- A forward migration makes `tasks_tasks_parent_type_matrix_update` and
  `trg_tasks_tasks_status_pipeline_update` require that one of their columns
  changed (`OLD.x IS NOT NEW.x`). A real change into an invalid pair is still
  refused; the rule text and the suspend clause are unchanged.
- `upsertSingleTask` on an existing row now issues an UPDATE with only the
  columns whose value changed, and no UPDATE at all for a no-op write. Sync
  capture is unchanged: it already recorded only changed columns, and
  status-group frames carry the full group.
- A refused task write (upsert or field update) is a `CleoError` that names
  the trigger's SQLite message, maps `E_TASK_PARENT_TYPE_MATRIX`,
  `E_TASK_PARENT_CYCLE` and `T877_INVARIANT_VIOLATION` to their exit codes, and
  keeps the first 200 characters of the SQL instead of the whole statement.
