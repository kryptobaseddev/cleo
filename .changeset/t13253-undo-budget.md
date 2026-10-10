---
id: t13253-undo-budget
tasks: [T13253]
kind: feat
summary: Sync undo budget - warn from 80 percent, persist an exceeded warning at 100 percent, never stop writing undo
---

This is part A of journal spec §3.5 Rule 2 (C1, D5). Part B, the rebind and retire at the next pull to head, waits for S4's pull and is
tracked as T13278.

- **`UNDO_BUDGET_BYTES` (256 MiB per store).** `undoBudget()` measures the undo payload held for unsequenced local transactions: the
  `_sync_undo` images plus the `_sync_row_undo` snapshots.
- **From 80%,** status and the doctor warn and suggest a pull.
- **At 100%,** every pull persists `sync.undo_budget_exceeded`: the `undo_budget_exceeded` warning and the rebind it schedules. Writing undo
  never stops. Only the rebind clears the warning.
- **Where it shows:** `ApplyReport.undoBudget` (every pull), `CloudStatusSyncStream.undo` and the `cleo cloud status` line, and
  `cleo doctor sync-journal`.
