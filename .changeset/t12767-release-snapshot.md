---
id: t12767-release-snapshot
tasks: [T12767]
kind: feat
summary: cleo doctor twin-collapse --release-snapshot lets a checked pre-collapse snapshot rotate again
---

A pre-collapse snapshot that a twin-collapse marker references is pinned, and
rotation never deletes it. `cleo doctor twin-collapse --release-snapshot <id>`
(`<id>` is the backup id, for example `migration-20260928-153200`) releases it
once it is no longer needed. It is allowed only after a verified recovery
(`--recover`), or when a no-recovery-needed check against the snapshot finds
nothing the live store lacks. It is refused while anything is left to
recover, when the snapshot is missing, or when a marker the recovery does not
cover references it.

- `--dry-run` shows the plan: the bytes reclaimed once the snapshot rotates,
  the markers, the basis for the release, and any blockers.
- A release needs `--confirm`. The owner's decision comes through the calling
  agent's ask tool, and the CLI never prompts.
- The release runs in one transaction. It clears the markers' reference to
  the snapshot and its sidecar pin, and appends a row to
  `.cleo/audit/twin-collapse-release.jsonl`. A failed audit write refuses the
  release.
- The snapshot file itself is never touched, and it rotates normally
  afterwards.
- Run from a git worktree, it needs `--confirm-owner-store`.
- It releases only this store's own snapshot, one in `<db dir>/backups/sqlite/`
  (T12772). A moved store's snapshot is found there by file name (T12788), and
  the audit row records `movedFrom`.
