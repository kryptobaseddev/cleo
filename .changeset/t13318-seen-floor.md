---
id: t13318-seen-floor
tasks: [T13318]
kind: feat
summary: "The cloud pull prunes its seen-transaction ledger below a per-origin local_seq floor, and refuses loudly below it"
---

A transaction id is `<replica>:<local_seq>`, and every origin's transactions are first delivered in `local_seq` order:
the sealer mints `local_seq` rising, a segment packs the lowest sealed transactions in order, uploads go out lowest
`replicaSeq` first, and every puller refuses a `replicaSeq` gap or replay. The pull now relies on that.

- A new local-only journal table, `_sync_seen_floor`, keeps per stream and origin the highest `local_seq` staged, how far
  its seen rows were pruned (`pruned_upto`), and the row and byte counts. Its migration seeds it from rows already staged.
- A transaction at or below its origin's floor with no seen row is refused with `refusedKind: 'below-floor'`, and the pull
  stops before its segment. The message says whether its seen row was pruned or it arrived out of order. It is never
  skipped as seen.
- A segment carrying a transaction that is not its replica's is refused (`refusedKind: 'segment'`).
- The cloud pull prunes each origin's seen rows below its floor after every pull, keeping the floor's own row.
  `pullStream`'s `pruneSeenUpTo` (a stream-seq floor no caller used) is replaced by `pruneSeen`.
- `cleo cloud status` sums the per-origin counts instead of walking the whole ledger.
- Vault bundles clear `_sync_seen_floor` together with `_sync_seen_txn` and `_sync_cursor`.
