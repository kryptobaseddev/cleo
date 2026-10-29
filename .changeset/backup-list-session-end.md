---
id: backup-list-session-end
tasks: [T14150]
kind: fix
summary: "cleo backup list shows the session-end snapshots and the runs that failed or were skipped"
---

`cleo backup list` read only the sidecars that `cleo backup add` writes.
The session-end `VACUUM INTO` snapshots (`tasks-*.db` and the rest) never
appeared, and a run that failed or was skipped was visible only in
`.cleo/logs/session-end-snapshot.log`.

The list now adds:
- **One `session-end` entry per run:** the files that share its timestamp,
  `outcome: written`, and a `restore` command, because these snapshots have no
  sidecar for `--id` and restore by file through
  `cleo restore backup --snapshot <file>`.
- **The runs the session-end worker logged as failed or skipped:** each with
  `outcome` set to `failed` or `skipped` and the cause.

Hourly global auto backups were already listed under `--scope global`.
