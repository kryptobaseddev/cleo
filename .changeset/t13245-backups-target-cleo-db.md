---
id: t13245-backups-target-cleo-db
tasks: [T13245, T13258, T13286]
kind: fix
summary: backup recover and restore-by-id now restore the live cleo.db; the global store gets backups and a restore path; backup add writes one cleo.db copy
---

**Backups always captured the live store.** `backup add` and the session-end snapshots copy
`.cleo/cleo.db`, which holds the tasks, brain and conduit tables. The recovery paths were what
missed it:
- `cleo backup recover tasks|brain` repaired `.cleo/tasks.db` / `.cleo/brain.db`, files nothing
  reads, because the database inventory still names them.
- The dispatch restore by id copied the labelled files onto those same paths.
- `cleo backup recover tasks` was not even reachable: citty resolved `tasks` as an unknown
  subcommand.
- `cleo backup recover brain` ran twice: citty runs the parent after the matched leaf, passing
  the leaf name as the positional argument.

**Now:**
- **`cleo backup recover tasks|brain|conduit`** picks the freshest snapshot that passes
  `quick_check`, or a pinned one. Candidates include session-end snapshots and `backup add`
  copies, but never a kept `pre-restore-*` store. It restores through the safe path of
  `cleo restore backup`: verified private copy, live writers refused, restore marker, replaced
  store kept, WAL handled. `--force` lets it proceed when the live store is too damaged to check
  for writers and every cleo process is stopped. Each leaf runs once.
- **The dispatch restore by id** places the store file on the live `cleo.db` through that same
  path, then restores the JSON files.
- **The global store** (`<CLEO_HOME>/cleo.db`: the global brain, nexus and agent registry) had no
  backup and no restore. Now:
  - `cleo backup add --global` writes one `VACUUM INTO` copy to `<CLEO_HOME>/backups/sqlite/`;
  - the session end takes an `auto` global backup at most once an hour. Concurrent session ends
    across projects take ONE: the backup runs single-flight under a cross-process lock, re-checks
    its age under it, and is admitted by the governor as `db-heavy` (skipped under pressure);
  - `cleo backup list --scope global|project|all` honours its scope;
  - `cleo restore backup --scope global --id|--snapshot` restores it the same safe way. Nearly
    every cleo process holds the global store open, so a global restore usually needs all of them
    stopped (agent sessions, daemons, Studio); the help text and the busy refusal say so.

  A project snapshot is never placed as the global store, nor the reverse.
- **Dedup.** `backup add` writes one `cleo.db.<backupId>` instead of two identical `tasks.db.` /
  `brain.db.` copies. `backup list` shows what each backup holds (`contains: tasks, brain,
  conduit` or `global`). Backups with the old labels are still listed with their contents, and
  restore, recover and verify all still read them. A failed `VACUUM INTO` no longer leaves an
  empty file that reads as a backup.

**Restore marker hardening (T13258 review LOWs on #1902).**
- **Stale detection survives a hostname change.** A marker records its holder's stable device id
  (read-only lookup: an open that meets a marker never writes, and falls back to the hostname),
  so a crashed restore on this machine is recognised as stale even after the hostname changes
  (macOS changes it with the network). Any marker older than an hour is also stale.
- **Opens re-check after opening.** An open checks the marker again after it opens: one written
  in between means the handle may be on the file being replaced, so it is closed and the open
  waits again.

