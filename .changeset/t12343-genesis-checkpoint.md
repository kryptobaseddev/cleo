---
id: t12343-genesis-checkpoint
tasks: [T12343, T13300, T13302]
kind: feat
summary: "`cleo sync enable push` - genesis cut plus genesis checkpoint (checkpoint/v3), behind the unreleased sync.push flag"
---

`cleo sync enable push [--scope project|global]` starts a store's change-journal push (journal spec §2.11 §10; T12343 S4-1b). It is
refused while `sync.push` is unreleased; the core call `enableSyncPush` takes an `allowUnreleased` opt-in for tests and staging
only.

- **What it checks first:**
  - the store's bound replica must be the one the stream knows (the link);
  - this machine must have synced the stream's head (pull first);
  - a stream whose head is already a journal checkpoint is refused with `E_NEXUS_SYNC_STREAM_JOURNALED`, so this store joins it by
    pulling instead of writing a second genesis.
- **Under the write lease:**
  - It commits the genesis cut, then exports the store as the cut left it through the vault's bundle export
    (`cutGenesisWithSnapshot`; the genesis marker holds every other writer off meanwhile). A failed export, or a write that raced
    it, undoes the cut, and nothing is saved or pushed.
  - It saves the bundle beside the store, then pushes a **checkpoint/v3** genesis: the vault manifest with empty
    `pending`/`voided`/`revived`/`pruned` and the store's replay pin. The parent is the current head (null only on an empty
    stream), and a count-delta segment is appended when the rows differ from the parent plus the window.
  - A window that crosses a sync-schema rise is refused (its pin would need that rise's journal hash).
- **After the checkpoint is stored:**
  - `completeGenesis` raises the store's replicaSeq high-water mark to the replica's last segment on the stream (the vault's delta
    segments spend this replica's seqs), and clears `genesis_pending`.
  - The saved bundle is removed.
  - A push that fails after the cut keeps the bundle and resumes on the next run (`status: 'resumed'`), without a second cut. A
    cut that crashed before its bundle was saved is resumed at that cut, or re-cut if the store moved on (T13301).
- **A genesis the server already stored is adopted, never cut twice (T13302).** `genesis_pending` means "not confirmed stored". If
  a run died after the upload was accepted, the next run finds that checkpoint on the stream by the id recorded beside the bundle
  before each upload (`Journal.pushCheckpoint` now takes a caller-minted `checkpointId`). It verifies the checkpoint, records it
  (high-water mark, pending cleared), and pushes no second genesis, even after a local write.
- **`cleo cloud push` refuses a store past its genesis cut.** Its changes travel as journal segments; a vault delta would count them
  twice.
- **New error codes:** `E_NEXUS_SYNC_REFUSED`, `E_NEXUS_SYNC_STREAM_JOURNALED`.
- **Refactor:** the vault's replay, delta and checkpoint loop is now `appendCheckpoint`, shared by `cloud push` and the genesis push.
