---
id: backup-docs-bytes
tasks: [T13704, T13708, T13709, T13710]
kind: fix
summary: "cleo backup add and cleo restore backup --id now carry the docs blob store and attachments, so docs fetch works after a restore"
---

A backup held only `cleo.db`, config and project-info. After a restore,
`cleo docs fetch` failed with "bytes are not in the blob store", because doc
content lives in `.cleo/blobs/` and `.cleo/attachments/`.

`cleo backup add` now snapshots `blobs/manifest.db` and `attachments/index.db`
with VACUUM INTO, checked by `PRAGMA integrity_check`. The byte files go into
one shared content-addressed pool, `.cleo/backups/blobs/<sha256>`, written once
across backups. Each backup lists what it references in
`docs-bytes.json.<backupId>`. Rotation now keeps the newest N backups whole
(before, it counted files), and a pool file is deleted only once no remaining
backup references it.

`cleo restore backup --id` restores these surfaces with the store:
- It refuses while a docs database is open in another process.
- It first keeps the live docs bytes and databases in the `pre-restore-*`
  undo backup, and aborts if it cannot.
- It places only bytes that match their sha256, and databases that also pass
  `integrity_check`.
- Anything missing or bad makes the restore partial: it exits non-zero with
  `E_RESTORE_PARTIAL` and lists what failed.
