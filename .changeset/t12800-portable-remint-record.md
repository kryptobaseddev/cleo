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
- **`E_TASK_RENAMED` (exit 26).** When sync re-numbers a task after a
  display-id collision, the old id may now name another task. A guarded
  write sent to the old id (`--if-match`, or the claim holder's own write)
  no longer lands on whatever row holds that id now. It is refused with
  `E_TASK_RENAMED`, and the details give the task's new id.

The check tolerates the early alias table that live stores upgraded through
the stamped migration still have.
