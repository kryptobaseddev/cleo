---
id: t13240-refill-undo
tasks: [T13240]
kind: fix
summary: cleo doctor row-identity --refill names cleo restore backup --snapshot as its undo, not a raw cp
---

The refill's undo instruction still printed a raw `cp <snapshot> cleo.db && rm -f cleo.db-wal cleo.db-shm`, from before `cleo restore backup --snapshot` existed. It now prints the guarded restore of the refill snapshot (with a `--dry-run` preview first), which verifies the snapshot, refuses while a writer holds the store, handles the WAL sidecars and keeps the replaced store as a pre-restore backup.
