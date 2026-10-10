---
id: t12343-segment-outbox
tasks: [T12343, T13287]
kind: feat
summary: Sync segment outbox - sealed transactions are packed and persisted before any push
---

This is the first slice of the signed transactional outbox (T12343 O-1, journal spec §2.8 "Building segments", "Persist before push").

- **`buildSegment(db, {stream, replica, scope, project, sealer, nowIso})`** packs the replica's own next sealed transactions, in local
  commit order, into one segment of a stream.
  - It first runs the one-time T13233 completion of pre-T13222 partial-group ops in the same transaction (T13287), so a segment never
    carries a partial op. Packing stops before an op it cannot complete.
  - The plaintext is `deflate-raw(canonical JSON of LedgerTxn[])`.
  - The segment/v3 metadata covers the op count, HLC range, per-table deltas (an I creates, a D deletes) and per-transaction deltas, at
    `SYNC_SCHEMA_VERSION`.
  - Packing stops at a plaintext budget; a transaction larger than the budget goes alone.
- **The caller's sealer encrypts the segment** (the journal client's `sealSegment`). One local transaction then:
  - persists the EXACT sealed bytes and their hash in `_sync_segment`, at the next gap-free `replicaSeq`;
  - raises the store's persisted `replicaSeq` high-water mark (`persistStoreSeq`), so a seq is never reused after its outbox row is
    pruned;
  - maps the transactions to the segment (`_sync_segment_txn`) and marks them `segmented`;
  - marks their rows `sent`;
  - writes the `row_identity_synced` marker if absent.

  A failing sealer leaves nothing behind.
- **Pushes resend the persisted bytes.** `unpushedSegments` returns them, lowest `replicaSeq` first, and `markSegmentPushed` records the
  server's seq. A segment is never re-sealed, so the server's (replica, hash) idempotency makes every resend safe.
- **A segmented transaction stays unsequenced until its echo.** It is still rewound and replayed by a scoped rebase.
- **New sync-journal migration** `t12343-segment-outbox`, local-only.
