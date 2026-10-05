---
id: t13240-restore-store-snapshot
tasks: [T13240]
kind: fix
summary: cleo restore backup --snapshot <file> | --id <backupId> restores the live cleo.db safely; --file tasks.db no longer reports a restore that wrote a file nothing reads
---

**Before this change, no `cleo` command could restore the live project store.**
- `cleo restore backup --file tasks.db` (the default) copied a numbered backup to `.cleo/tasks.db`.
- `restoreBackup` by id wrote `.cleo/tasks.db` and `.cleo/brain.db`.
- Since the store consolidation, the store is `.cleo/cleo.db`, which holds the tasks AND the brain
  tables. Both paths reported success and changed nothing CLEO reads.

**`cleo restore backup --snapshot <file>` or `--id <backupId>`** (with `--dry-run` to preview)
restores `.cleo/cleo.db` in this order:
1. **Source.** A snapshot must be under this project's `.cleo/backups/`; `--allow-external`
   accepts another location. A backup id is a plain name (no traversal) whose sidecar names its
   store file. A snapshot with a non-empty `-wal` beside it is refused, because its newest commits
   are not in the file.
2. **Verify a private copy.** The SQLite header, `PRAGMA integrity_check`, and a project store's
   shape (`tasks_tasks`). The verified copy is what gets placed.
3. **Live writers refuse.** This process's handles are closed. A live writer lease held by another
   process refuses, and so does any other connection holding the file open. This is checked again
   under the first-open lock.
4. **Keep the replaced store.** It is copied with its WAL, the WAL is folded into the copy, and it
   is listed as a pinned `pre-restore-*` backup. `cleo restore backup --id pre-restore-…` undoes
   the restore.
5. **Place.** The live `-wal`/`-shm`/`-journal` are removed (they belong to the replaced file),
   the verified copy is renamed over `cleo.db`, and the result is checked again.

**Legacy paths.**
- `--file tasks.db|brain.db|cleo.db` now refuses with `E_RESTORE_STORE_LABEL` and points to
  `--id`/`--snapshot`. `--file config.json` is unchanged.
- The legacy id restore never plain-copies `cleo.db`.
