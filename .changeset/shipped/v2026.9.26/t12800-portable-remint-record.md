---
id: t12800-portable-remint-record
tasks: [T12800]
kind: fix
summary: A display-id re-mint's outcome no longer depends on local-only state, and a guarded write to a re-numbered task fails with E_TASK_RENAMED (row uids, opt-in)
---

- **The re-mint record is portable.** Which re-mint of a task wins (the
  greatest HLC), and which id a task that arrives later lands on, used to
  come from a local-only meta table. A device that lost that table, or never
  had it, could apply an older re-mint and end up with a different id.
  Every re-mint now records the id it assigned as a `remint-assigned` display
  alias. Aliases travel with the task, and the winner is derived from them,
  so every device reaches the same answer.
- **Alias rows converge.** The alias key now includes the reason, and a
  second write of one alias keeps the earliest displacement, so every device
  holds the same alias rows whatever order the re-mints arrived in. Alias
  rows received through sync are placed under the same key.
- **`E_TASK_RENAMED` (exit 26).** When sync re-numbers a task after a
  display-id collision, the old id may now name another task. A guarded
  write sent to the old id no longer lands on whatever row holds that id
  now: an `--if-match` of exactly the version the task had under that id,
  or a renew/release of the claim the caller holds on it, is refused with
  `E_TASK_RENAMED`, and the details give the task's new id. Only renames
  this store performed in the last 24 hours count. A stale `--if-match` on
  the task that holds the id now is still `E_CONFLICT` (23), and acquiring
  it (as `orchestrate pivot` does) is never refused as renamed. The gateway
  and `orchestrate pivot` report the code as `E_TASK_RENAMED`, not
  `E_GENERAL`.

The check reads nothing on live stores whose uid migration was stamped
without running (no `tasks_row_identity_meta`); it never fails the write there.
