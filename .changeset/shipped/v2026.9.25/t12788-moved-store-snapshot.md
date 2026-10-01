---
id: t12788-moved-store-snapshot
tasks: [T12788]
kind: fix
summary: twin-collapse --recover finds a moved store's snapshot by file name in its own backup directory and re-points the markers
---

A store that moved (`/mnt` → `/home`, Linux → Mac) keeps collapse markers
that name the old absolute snapshot path. Before this fix, `cleo doctor
twin-collapse --recover` refused them. Now, when the marker path is outside
`<db dir>/backups/sqlite/` but `<db dir>/backups/sqlite/<basename>` exists, is
a migration backup, and starts with the SQLite header, `--recover`,
`--dry-run` and `--pin-snapshot` use that file. The plan reports `movedFrom`.

An apply re-points every marker that names the old path at the local file,
inside its transaction and even when nothing is left to recover. It appends
a row to `.cleo/audit/twin-collapse-repoint.jsonl` before committing. A dry
run re-points nothing. A file of that name that is not a SQLite snapshot is
still refused.
