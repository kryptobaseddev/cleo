---
id: t13107-t13108-restore-file-state-keys
tasks: [T13107, T13108]
kind: fix
summary: A vault restore takes the row-identity markers and the sync-schema ledger from the snapshot, so a restored store rewrites its timestamps and seals
---

Two local-only key/value tables mix keys that describe the database file with keys that describe this
machine. Until now `cleo cloud pull` and `cleo cloud restore` carried both tables whole from the live store:

- `tasks_row_identity_meta`: the canonical-timestamp marker (`timestamp_canon_v1`) came from this device. A
  snapshot that predates the rewrite, pulled onto a device that had already rewritten, therefore never got its
  timestamps rewritten when capture was on.
- `_sync_meta`: the sync-schema ledger (`schema:<folder>`) came from this device. It could claim sync tables the
  snapshot does not have, such as an older device's snapshot without the sealer tables, so the sealer failed once
  sealing was on.

A restore now carries these tables key by key. These keys come from the snapshot: the uid recipe, the "uids have
left the device" marker, the timestamp marker and the ledger. This machine's keys stay this machine's: local
rename records, `sync.*` flags, the writer-version floor, replica seqs, suspect marks and sealer counters. When the
snapshot has no `_sync_meta` at all, it is created for this machine's flags, and the next open applies the sync
schema. A restored store now rewrites its timestamps on the next capture open and seals its next write.
