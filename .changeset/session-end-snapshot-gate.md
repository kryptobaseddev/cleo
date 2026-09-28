---
id: session-end-snapshot-gate
tasks: [T12508]
kind: fix
summary: "`cleo session end` now takes a session-end SQLite snapshot, in a detached worker behind one cross-process gate: bursts produce one snapshot, the command never waits on a VACUUM, each physical database file is VACUUMed once, and retention keeps time-spread slots instead of the newest 10"
---
**What was wrong.** The session-end snapshot was a `SessionEnd` hook calling
`vacuumIntoBackupAll({ force: true })`. The debounce lived in process memory,
and `force` bypassed it anyway. When several agents ended their sessions
together, each process wrote its own full snapshot. On 2026-09-27 that
produced four 1.3 GB `tasks-*.db` files in ten seconds, and the newest-10
rotation then deleted the older recovery points.

Worse, the hook was only reached by the SDK's `endSession`. The CLI path —
`cleo session end`, the Claude Code Stop hook, orchestrate handoff, safestop and
GC — goes through `session/engine-ops.ts` `sessionEnd`, and that never
snapshotted at all. The tasks, brain and conduit targets also all resolve to the
same `cleo.db`, so each SDK snapshot wrote three full copies.

**What happens now when a session ends.** Both `sessionEnd` (CLI/dispatch) and
`endSession` (SDK) call `requestSessionEndSnapshot` as their last step, after
the session row is written as ended. It reads the current snapshot generation
and spawns a detached, unref'd worker (`sessions/session-end-snapshot-entry.js`),
then returns. The command that ended the session does not wait for a VACUUM.

The worker takes the snapshot through the gate's `required` mode with that
generation. It waits for the lock, and it is satisfied by any snapshot that
started after the request, so a burst of session ends produces one snapshot,
plus at most one trailing snapshot for requests made while it ran. The worker
appends its outcome as one JSON line to `.cleo/logs/session-end-snapshot.log`.

If the worker cannot be spawned, or `CLEO_SESSION_END_SNAPSHOT=inline` is set,
the snapshot runs in-process with a lock wait of about 6.5 s. Under vitest it
runs inline by default.

- **One snapshot at a time per project.** Every project-tier snapshot takes a
  cross-process lock on `.cleo/backups/sqlite/.snapshot-gate`. It reuses
  `acquireLock` (proper-lockfile). No path bypasses the lock.
  `VacuumOptions.force` is removed, and a `force` property passed at runtime is
  ignored.
- **Gate state in `cleo.db`.** State is stored in `schema_meta` (key
  `sqlite_snapshot_gate`) and holds a generation counter, claimed under the
  lock before a run starts, plus per-prefix records of the last satisfied run.
  If the claim cannot be written, the run records nothing, so it cannot cover
  a request.
  - `routine` mode, used by per-write checkpoints: debounced for five minutes.
    If a snapshot is already running, the request is skipped. Without the
    state row, no snapshot is taken.
  - `required` mode, used by session end and pre-destructive checkpoints: not
    debounced. It is covered only by a later generation, so no wall clock is
    involved. It works without the state row. A lock that stays held returns
    `lock-timeout` with the lock path; it is never skipped silently.
- **One VACUUM per physical file.** Targets that resolve to the same database
  file are snapshotted once. The other prefixes get a hard link to the same
  file, so `brain-*.db` and `conduit-*.db` still exist for restore, listing
  and `recover-brain-db`, at no extra disk cost.
- **Snapshots come from the right project.** Target handles are resolved for
  the requested project (`cwd`). A project-tier handle whose file lies outside
  that project's `.cleo/` is refused as `failed`.
- **Absent is not failed.** A database the project does not have is reported
  `absent` and satisfies admission. An existing file that cannot be opened,
  including one that fails with EACCES, is `failed`.
- **No same-second collisions.** The filename is stamped under the lock. If
  `<prefix>-YYYYMMDD-HHmmss.db` already exists, the snapshot waits for the next
  second. The filename format is unchanged.
- **Pre-destructive snapshots are ordered.** `forceCheckpointBeforeOperation`
  (used before the storage migration in `upgrade.ts`) and `forceSafetyCheckpoint`
  await the snapshot and return its outcome. `cleo upgrade` reports a
  `pre_migration_snapshot` action when none was taken.
- **Time-spread retention.** Each prefix keeps the newest file, plus the newest
  file in each of the 3 most recent quarter hours, 3 hours and 3 days that have
  snapshots. That is at most 10 files. The file just written is always kept.
  Files with a future-dated or impossible stamp are kept but win no slot.
- `vacuumIntoBackupAll` and `vacuumIntoBackup` return the gate outcome
  (`{ snapshotted, linked, absent, failed, skipped, error? }`, or `null`).
- Known gap, tracked separately: a lock left by a SIGKILLed process blocks
  snapshots until it goes stale (10 minutes), and that is logged at warn level.
