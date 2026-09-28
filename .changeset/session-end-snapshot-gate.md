---
id: session-end-snapshot-gate
tasks: [T12508]
kind: fix
summary: "A burst of session ends no longer writes a snapshot per process. Project snapshots pass one cross-process gate with a debounce stored in cleo.db, and retention keeps latest, hourly and daily slots instead of the newest 10"
---
`cleo session end` called `vacuumIntoBackupAll({ force: true })`. The debounce
lived in process memory, and `force` bypassed it anyway. When several agents
ended their sessions together, each process wrote its own full snapshot. On
2026-09-27 that produced four 1.3 GB `tasks-*.db` files in ten seconds, and the
newest-10 rotation then deleted the older recovery points.

- **One snapshot in flight per project.** Every project-tier snapshot
  (`vacuumIntoBackupAll`, `vacuumIntoBackup`) takes a cross-process lock on
  `.cleo/backups/sqlite/.snapshot-gate`. It reuses `acquireLock`
  (proper-lockfile) with zero retries. A caller that finds the lock held skips,
  because the snapshot already running covers its request.
- **Debounce stored in the database.** The start time of each snapshot prefix
  is written to `schema_meta` (key `sqlite_snapshot_gate`) in the project
  `cleo.db` before the snapshot runs. It is re-read under the lock, so a burst
  from many processes inside the five-minute window produces one snapshot. A
  snapshot that fails also counts toward the window, so a failing snapshot
  cannot retry in a loop. If the state store cannot be opened, the gate takes
  no snapshot.
- **No `force`.** `VacuumOptions.force` is removed. The session-end hook and
  the pre-destructive checkpoints in `data-safety-central.ts` go through the
  same gate. A `force` property passed at runtime is ignored.
- **Time-spread retention.** Project snapshots keep the 2 newest files, plus
  the newest file in each of the 4 most recent hours and the 4 most recent days
  that have snapshots. That is still at most 10 files per prefix. A burst fills
  only the "latest" slots and one hourly bucket. Buckets come from the
  filename timestamp, not mtime. Pruning now runs after the new snapshot is
  written, so a failed `VACUUM INTO` no longer costs an existing snapshot.
- `vacuumIntoBackupAll` and `vacuumIntoBackup` now return the gate outcome
  (`{ snapshotted, skipped }`, or `null`) instead of `void`.
