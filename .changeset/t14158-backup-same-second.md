---
id: t14158-backup-same-second
tasks: [T14158]
kind: fix
summary: "two backups of one type in the same second no longer collide: the second used the same id, its VACUUM INTO failed, and the cleanup deleted the first backup's store copy"
---

`createBackup` and the global backup named each backup `<type>-YYYYMMDD-HHmmss`.
A second backup of the same type in the same second reused the id. For a
project backup the VACUUM INTO into the existing file failed, and its
partial-file cleanup deleted the FIRST backup's `cleo.db` copy; a global backup
silently replaced the earlier copy by rename. Relocation checkpoints
(`cleo project move`) taken back to back hit this: the checkpoint reported
"the project database was not captured".

The id now moves forward a second at a time until it is free, so the
`<type>-YYYYMMDD-HHmmss` format every reader parses is unchanged.
