---
id: t14158-backup-same-second
tasks: [T14158]
kind: fix
summary: "a backup never deletes or replaces another backup: snapshots publish with a no-clobber link, and a backup whose id is taken moves to the next free id"
---

`createBackup` and the global backup named each backup `<type>-YYYYMMDD-HHmmss`.
A second backup of the same type in the same second reused the id. For a
project backup the VACUUM INTO into the existing file failed, and its
partial-file cleanup deleted the FIRST backup's `cleo.db` copy; a global backup
silently replaced the earlier copy by rename. Relocation checkpoints
(`cleo project move`) taken back to back hit this: the checkpoint reported
"the project database was not captured".

- Every store snapshot is written to a fresh temp file beside its target and
  published with a hard link (an exclusive copy where links are unsupported),
  which fails when the target exists. A failure removes only that temp file;
  an existing backup is never removed or replaced.
- The id moves forward a second at a time until it is free, and a backup
  whose id another writer published first retries with the next free id. The
  `<type>-YYYYMMDD-HHmmss` format every reader parses is unchanged.
