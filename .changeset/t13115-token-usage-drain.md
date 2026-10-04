---
id: t13115-token-usage-drain
tasks: [T13115]
kind: fix
summary: Token reports cover all history again (the bare token_usage table is drained into tasks_token_usage at open)
---

T13111 moved token usage to `tasks_token_usage`, which left the rows in the old bare `token_usage`
table out of `cleo token` reports. The twin collapse (T12535) now drains that table into
`tasks_token_usage` at every open, so reports cover all history. This replaces T13111's note that
those rows stay in the bare table, and `cleo token delete` and `clear` now touch `tasks_token_usage`
only.

How the drain treats each bare row:

- **Missing from `tasks_token_usage`:** the row is carried and removed from the bare table. Only the
  columns both tables hold are copied, so a cut-down legacy shape on either side drains what it can.
- **Already there, identical** (a store an older build reconciled can hold the same rows in both
  tables): the bare copy is removed. Each row lands once.
- **Already there, different:** `tasks_token_usage` wins. The bare copy stays where it is, listed as a
  conflict.
- **Refused by `tasks_token_usage`, or not read back verbatim** (a CHECK, NOT NULL or type mismatch,
  or a value it stores differently), or holding a value in a column `tasks_token_usage` lacks: the
  row stays in the bare table, listed as a conflict. One bad row never fails the open.

A row the drain leaves behind is not decided again unless it changes, so a token row you delete
cannot come back from it. `cleo doctor twin-collapse` lists these rows.

Nothing is lost and nothing degrades:

- The drain removes a bare row only when `tasks_token_usage` holds every value of it, so it takes no
  pre-collapse snapshot.
- If it fails (a read-only store, a lock), the failure is recorded for `cleo doctor twin-collapse`
  and the next open retries. Reads, token writes and every other command carry on, because
  `tasks_token_usage` is correct whatever the bare table still holds.
- A long legacy table drains in transactions of at most 2,000 rows, so no open holds the write lock
  for all of it.
- An unchanged bare table costs one count read.

An older CLEO that reads the same store sees only the token rows it wrote since the last drain,
because the earlier ones have moved to `tasks_token_usage`.
