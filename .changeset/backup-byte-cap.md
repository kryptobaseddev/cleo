---
id: backup-byte-cap
tasks: [T14278]
kind: fix
summary: "One byte cap over .cleo/backups/sqlite: oldest provably redundant snapshots go first, the newest that opens never goes, and migration snapshots join the rotation"
---

Three snapshot families shared `.cleo/backups/sqlite` with separate rotations,
and the store's migration snapshots never rotated: 23 GB for a 1.3 GB store.

After every snapshot (session end, `cleo backup add`, a migration snapshot) the
directory is held at or under `backup.maxBytes`, by default five times the live
store's size. Only provably redundant sets are removed, oldest first: a set
strictly older than the newest store snapshot that opens, which holds
everything it held. That newest verified snapshot, anything as new or newer, a
pinned backup and a pre-collapse snapshot a twin-collapse marker references are
never removed (and no migration set is when the markers cannot be read). With
no snapshot that opens nothing is removed. Each removal is appended to
`rotation.jsonl` with the snapshot that covers it.
