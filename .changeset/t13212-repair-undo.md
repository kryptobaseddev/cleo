---
id: t13212-repair-undo
tasks: [T13212]
kind: fix
summary: The sync repair diff runs while undo is on - repair captures write their own undo
---

`repairSuspectTables` refused outright while `undo_enabled` was set: its captures are written directly, not by the capture triggers,
so they carried no `_sync_undo`. A store past its genesis cut could never repair a suspect table.

- While undo is on, each repair capture writes its `_sync_undo` row, stamped with the repair frame (`kind = 'repair'`). The
  transaction then has a position, keeps its undo until its echo (§3.5 Rule 2, D1), and counts toward the undo budget.
  - **I:** the row now (`after_full`).
  - **U:** the row now only. The value before the uncaptured write is lost, so `before_full` is NULL, a flag a trigger-written U
    never carries.
  - **D:** what row meta knows (`before_full` = its key).
  - An append-only table keeps neither image, as its triggers do.
- The refusal is gone. A rewind restores merge state from the sealer's `_sync_row_undo` snapshot, as for any local op.
