---
id: one-store-under-cleo-dir-pin
tasks: [T14153]
kind: fix
summary: "Backups, session-end snapshot paths and the Nexus binding resolve the project's .cleo the same way the database does"
---

An absolute `CLEO_DIR` pins the store for the whole process, so under a pin
`getCleoDir(root)` returns the pinned directory whatever root is passed. That
is intended: test isolation, `--cleo-dir` and the cleo-os harness rely on it.
Some code instead built `<root>/.cleo` for the same project, so under a pin
the two halves read different stores. Three places did this:

- `createBackup`, `listSystemBackups` and restore by id snapshotted the pinned
  database into the root's backup directory.
- The session-end snapshot marker and log lived on one path while the backup
  listing read another.
- The Nexus binding came from the pinned store while the project id came from
  the root.

All three now use `resolveCleoDir`, the database's resolver, for both halves,
and the pin contract is documented on `getCleoDir` and `getCleoDirAbsolute`.
