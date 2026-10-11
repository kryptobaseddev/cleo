---
id: t13312-journal-join
tasks: [T13312, T12999, T12996]
kind: feat
summary: "`cleo sync enable push` joins a stream another device journaled, from the journal checkpoint this store restored"
---

A second device can now enter a stream whose change journal another device already started (T13312, T12999). Before this, a
store restored from the journal checkpoint carried no row meta and no join state, so `cleo sync enable push` refused it and
there was no way in.

- **Restore keeps the journal's row state.** On a journal checkpoint, the restore keeps the snapshot's `_sync_row_meta` and
  `_sync_field_leave` rows instead of clearing them as machine-local.
- **The join.** On a stream whose head is a journal checkpoint this store restored, `cleo sync enable push` returns status
  `joined`:
  - the store's cut is placed at its current capture position;
  - the ledgers are baselined;
  - push, pull and undo are turned on;
  - pulling resumes right after the restored checkpoint.
  No second genesis is pushed.
- **A changed store is refused, never folded.** The join is refused with `E_NEXUS_SYNC_REFUSED` when:
  - any table's rows differ from the checkpoint's manifest;
  - any row no longer matches its restored row meta;
  - a capture is still waiting to seal;
  - a write landed after the check, which is caught inside the cut's own transaction, so it is never baselined as
    checkpoint state.
  The remedy is to restore the checkpoint again (`cleo cloud restore --force`), then join. A refused join changes nothing: capture is left as it was found, and sealing stays off.
- **A store that never restored the journal checkpoint** gets `E_NEXUS_SYNC_STREAM_JOURNALED`, naming the restore-then-join
  path. The pull refusal for a store behind the journal genesis (T13306) names the same path.
- `sync.push` and `sync.pull` stay unreleased.
