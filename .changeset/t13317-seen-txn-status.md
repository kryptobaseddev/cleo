---
id: t13317-seen-txn-status
tasks: [T13317]
kind: feat
summary: "`cleo cloud status` reports the seen-transaction ledger's size per store, since nothing prunes it yet"
---

The pull records each transaction it stages in `_sync_seen_txn`, so a re-delivered transaction is never applied twice.
Nothing prunes that ledger yet. A seen transaction can come back in a new segment above any checkpoint, so pruning
waits for a proven refusal floor (T13318). In the meantime, its growth is now visible.

- `cleo cloud status` now includes `seenTxns` in each store's sync block: `{rows, bytes, byStream}`.
  - `bytes` counts the stored stream and txn text plus an 8-byte seq per row, without SQLite page overhead.
- The human line adds `<n> seen txn(s), about <size> KiB` once the ledger holds rows.
- Nothing prunes `_sync_seen_txn`.
