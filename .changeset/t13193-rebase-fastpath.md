---
id: t13193-rebase-fastpath
tasks: [T13193]
kind: feat
summary: Own-echo fast path for the sync rebase, with a foreign-touch index and a per-op row undo of the merge state
---

This is the first slice of the scoped rebase (T13193 R-1), against journal spec §3.5 Rules 2 and 3.

- **Own-echo fast path.** When this replica's own sealed transaction comes back through the stream, it is sequenced if no foreign
  transaction applied after its commit touched its rows. The stream order then agrees with the local order: the transaction is recorded
  in `_sync_sequenced`, and its undo and row undo are dropped. Otherwise it stays unsequenced, with its undo intact, for the scoped rebase.
- **The order is exact, with no clock.** A local transaction's position is its first capture's seq. A foreign touch records the capture
  sequence when its transaction applied. Both come from the same AUTOINCREMENT counter.
- **`_sync_foreign_touch`** holds only entries at or after the oldest unsequenced local transaction, and is empty when none is
  unsequenced. It is bounded by `FOREIGN_TOUCH_MAX` (200,000); past the bound it is marked incomplete and the fast path declines until
  the backlog drains.
- **`_sync_row_undo`.** While undo is on, the sealer snapshots each sealed local op's prior row meta, leaves and frontiers, so a rewind
  can restore merge state together with values.
- **`_sync_txn_frame` index.** Sequencing joins a local transaction to its frame's undo on every echo and every foreign apply, while
  the write lock is held. A partial index on `_sync_txn(frame)` stops each of those joins from scanning the whole sealed history (T13260).
- **New sync-journal migration** `t13193-rebase-undo` (all local-only). Undo still turns on only with S4's genesis cut, so this is inert
  on real stores until then.
