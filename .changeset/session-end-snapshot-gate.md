---
id: session-end-snapshot-gate
tasks: [T12508]
kind: fix
summary: "A burst of session ends no longer writes a snapshot per process. Project snapshots pass one cross-process gate, with state stored in cleo.db; session-end and pre-destructive snapshots are awaited and never debounced away; retention keeps time-spread slots instead of the newest 10"
---
`cleo session end` called `vacuumIntoBackupAll({ force: true })`. The debounce
lived in process memory, and `force` bypassed it anyway. When several agents
ended their sessions together, each process wrote its own full snapshot. On
2026-09-27 that produced four 1.3 GB `tasks-*.db` files in ten seconds, and the
newest-10 rotation then deleted the older recovery points.

- **One snapshot at a time per project.** Every project-tier snapshot takes a
  cross-process lock on `.cleo/backups/sqlite/.snapshot-gate`. It reuses
  `acquireLock` (proper-lockfile). No path bypasses the lock. `VacuumOptions.force`
  is removed, and a `force` property passed at runtime is ignored.
- **Two admission modes.** The start time of each prefix's last *successful*
  snapshot is stored in `schema_meta` (key `sqlite_snapshot_gate`) in the
  project `cleo.db` and re-read under the lock.
  - `routine`, used by per-write checkpoints: debounced for five minutes. If a
    snapshot is already running, the request is skipped. Without the state row,
    no snapshot is taken.
  - `required`, used by session end and pre-destructive checkpoints: not
    debounced. It waits up to about 90 s for the lock. It is satisfied only by a
    successful snapshot that started at or after the request, so the session's
    final writes are always captured. Every session end that queues behind one
    running snapshot is covered by it, so a burst produces one snapshot. It works
    without the state row. A lock that stays held returns `lock-timeout` with
    the lock path; it is never skipped silently.
- **Failures don't use up the window.** Only a snapshot that was written is
  recorded. A thrown `VACUUM INTO`, or a target with nothing to open, is
  reported as `failed`, and the next request runs.
- **Pre-destructive snapshots are ordered.** `forceCheckpointBeforeOperation`
  (used before the storage migration in `upgrade.ts`) and `forceSafetyCheckpoint`
  now await the snapshot. `wal_checkpoint` and `VACUUM INTO` finish before the
  caller's destructive step begins. Failures are still non-fatal, and are
  logged at error level with their cause.
- **Time-spread retention.** Each prefix keeps the newest file, plus the newest
  file in each of the 3 most recent quarter hours, 3 hours and 3 days that have
  snapshots. That is at most 10 files. A burst costs one slot of each kind, so
  older recovery points survive. The file just written is always kept. Files
  with a future-dated or impossible stamp are kept but win no slot, so clock
  skew cannot push out a real snapshot. Pruning runs after the new snapshot is
  written.
- `vacuumIntoBackupAll` and `vacuumIntoBackup` now return the gate outcome
  (`{ snapshotted, failed, skipped, error? }`, or `null`) instead of `void`.
