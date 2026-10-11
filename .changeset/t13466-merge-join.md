---
id: t13466-merge-join
tasks: [T13466]
kind: feat
summary: "Sync: a store that never synced with a journal stream joins it and keeps its own rows"
---

`cleo sync enable push` on a store that never synced with a stream the change journal already writes (another device
cut it) no longer refuses with `E_NEXUS_SYNC_STREAM_JOURNALED`. It joins the stream and merges (T13466):

- **The join** (`joinStream` with `merge`) skips the row check and the baseline, and records a copy reconcile due, so
  push waits for it.
- **The reconcile** (T13335's `reconcileCopy`) restores the stream's latest journal checkpoint into a scratch store,
  pulls it to head, adopts the stream's rows here and emits this store's own rows as its first transactions. A row both
  sides hold with the same birth takes the stream's row meta and content hash.
- **The result** reports `merged: { adopted, emitted, unresolved }`. A stream row this store cannot place (its key
  already held by a local row) is left out with `W_SYNC_MERGE_UNRESOLVED`; this store keeps its own. If the reconcile
  does not finish, `W_SYNC_MERGE_PENDING` says so and `cleo cloud sync` completes it.
- The journal-stream remedy text now tells a store that has not joined to run `cleo sync enable push`.
