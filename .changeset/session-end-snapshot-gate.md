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
- **Two admission modes.** Gate state is stored in `schema_meta` (key
  `sqlite_snapshot_gate`) in the project `cleo.db` and re-read under the lock.
  It holds a snapshot generation counter, which a run claims under the lock
  before it starts. For each prefix it records the generation and start time
  of the last run that satisfied it.
  - `routine`, used by per-write checkpoints: debounced for five minutes. If a
    snapshot is already running, the request is skipped. Without the state row,
    no snapshot is taken.
  - `required`, used by session end and pre-destructive checkpoints: not
    debounced. It is satisfied only by a run of a later generation than the one
    it saw when the request was made. No wall clock is involved, so a stepped
    clock or a same-millisecond request cannot fake coverage. Every request
    queued behind one running snapshot is covered by it, so a burst produces
    one snapshot. It works without the state row. A lock that stays held
    returns `lock-timeout` with the lock path; it is never skipped silently.
- **Absent databases are not failures.** A database the project does not
  have (e.g. no `llmtxt.db`) is reported as `absent`. It satisfies admission,
  so per-write checkpoints no longer take the lock over and over for nothing.
- **Failures don't use up the window.** Only written and absent prefixes are
  recorded. A thrown `VACUUM INTO`, or an existing file that cannot be opened,
  is reported as `failed`, and the next request runs.
- **No same-second collisions.** The filename is stamped under the lock, when
  the snapshot actually runs. If `<prefix>-YYYYMMDD-HHmmss.db` already exists,
  the snapshot waits for the next second instead of failing. The filename
  format is unchanged for every reader.
- **Session end captures the final state.** The snapshot is no longer a
  `SessionEnd` hook. Those run concurrently, before the session is persisted.
  `endSession` now takes it as its last step, after the memory bridge has run
  and the session row is written as ended. The lock wait there is short
  (about 6.5 s), because hosts run `cleo session end` in shutdown hooks that
  may be killed. A snapshot that is not taken is logged at warn level with its
  cause.
- **Pre-destructive snapshots are ordered.** `forceCheckpointBeforeOperation`
  (used before the storage migration in `upgrade.ts`) and `forceSafetyCheckpoint`
  now await the snapshot and return its outcome. `wal_checkpoint` and
  `VACUUM INTO` finish before the caller's destructive step begins. Failures
  are still non-fatal. They are logged at error level, and `cleo upgrade`
  reports a `pre_migration_snapshot` action when no snapshot was taken.
- **Time-spread retention.** Each prefix keeps the newest file, plus the newest
  file in each of the 3 most recent quarter hours, 3 hours and 3 days that have
  snapshots. That is at most 10 files. A burst costs one slot of each kind, so
  older recovery points survive. The file just written is always kept. Files
  with a future-dated or impossible stamp are kept but win no slot, so clock
  skew cannot push out a real snapshot. Pruning runs after the new snapshot is
  written.
- `vacuumIntoBackupAll` and `vacuumIntoBackup` now return the gate outcome
  (`{ snapshotted, absent, failed, skipped, error? }`, or `null`) instead of
  `void`.
