---
id: t13466-merge-join
tasks: [T13466, T13503, T13504, T13507, T13508]
kind: feat
summary: "Sync: a store that never synced with a journal stream joins it and keeps its own rows"
---

`cleo sync enable push` on a store that never synced with a stream the change journal already writes (another device
cut it) no longer refuses with `E_NEXUS_SYNC_STREAM_JOURNALED`. It joins the stream and merges (T13466):

- **The join** (`joinStream` with `merge`) skips the row check and the baseline, and records a copy reconcile due, so
  push waits for it.
- **The reconcile** (T13335's `reconcileCopy`) restores the stream's latest journal checkpoint into a scratch store,
  pulls it to head, adopts the stream's rows here and emits this store's own rows as its first transactions.
- **A row both sides hold** (same birth, one uid) is merged field by field (T13503). This store's value is dated as
  genesis dates an existing row (§1.2: its `updated_at`, else its birth column): a newer local value is kept and sent
  with that HLC pinned, so every device takes it; an older one takes the stream's value and is listed in
  `merged.overwritten` with `W_SYNC_MERGE_OVERWROTE`. The store is first exported to a `pre-merge-*` safety bundle
  (`merged.safetyBackup`).
- **A stream delete** of a row this store also holds (T13508) follows the same dating: a newer local edit keeps the
  row and re-inserts it above the tombstone on every device (`merged.replaced`, column `*`); an older copy is removed
  and listed in `merged.deleted` with `W_SYNC_MERGE_DELETED` naming the safety bundle.
- **The baseline** for "written on the stream after the cut" is the stream's cut (oldest journal) checkpoint. A stream
  field edited after the cut and later reverted still counts as written, so the stream's value wins; this store's
  value is recoverable from the safety bundle.
- **A stream row whose key this store's own row holds** (both devices minted `D0001`) refuses the join before
  anything changes (T13504): nothing settles such a collision across devices yet. Give the local row a free key and
  run `cleo sync enable push` again.
- **The result** reports `merged: { adopted, emitted, unresolved, overwritten, safetyBackup }`. A stream row whose
  reference does not resolve here is left out with `W_SYNC_MERGE_UNRESOLVED`. If the reconcile does not finish,
  `W_SYNC_MERGE_PENDING` says so and `cleo cloud sync` completes it.
- The journal-stream remedy text now tells a store that has not joined to run `cleo sync enable push`.
