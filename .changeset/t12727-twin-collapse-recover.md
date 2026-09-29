---
id: t12727-twin-collapse-recover
tasks: [T12727]
kind: fix
summary: cleo doctor twin-collapse --recover restores what a 2026.9.21 collapse dropped or replaced; --rollback undoes it
---

`cleo doctor twin-collapse --recover` reads the pre-collapse snapshot that the
collapse marker records. The snapshot is opened read-only and never modified.
The command copies every twin `schema_meta` value that 2026.9.21 dropped or
replaced into `twin_collapse_archive:<key>`. It then merges the twin's
`focus_state` session notes into the live value, once: live fields win, and
notes are deduplicated by timestamp and text, then sorted. Twin-only sticky tags
are archived under `twin_collapse_archive:sticky_tags`. An existing archive row
is never overwritten; the value goes under a suffixed key instead.

- `--dry-run` prints the exact plan and writes nothing.
- An apply re-reads the live values under the write lock, so a note written
  during the run is kept. It writes everything in one transaction, plus a new
  `twin_collapse_recovery:<time>` receipt holding the values it replaced. It is
  idempotent: notes pruned after a recovery stay pruned. It needs no network.
- `--rollback <receiptId>` undoes one apply. It deletes the archive keys and
  restores the pre-merge `focus_state` and sticky archive. If `focus_state`
  changed since, it removes only the recovered notes.
- A missing snapshot is an `E_TWIN_COLLAPSE_RECOVER` error, dry run included,
  and nothing changes. A store that was never collapsed is a no-op.
- Run from a git worktree, `--recover`, `--rollback` and `--retry` refuse to
  write the owning project's live store without `--confirm-owner-store`.

Stores collapsed by 2026.9.21 can be 2 migrations behind. The released cleo
applies them the first time it opens each store.
