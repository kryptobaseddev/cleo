---
id: t12727-recover-pin-kodomeet
tasks: [T12727]
kind: fix
summary: twin-collapse --recover reports and refuses an unpinned snapshot (--pin-snapshot) and restores a twin-only focus_state; rotation never deletes a marker-referenced snapshot
---

`cleo doctor twin-collapse --recover` now checks whether the pre-collapse
snapshot is pinned; an unpinned one is one rotation away from deletion.

- The plan reports `snapshotPinned`.
- An apply refuses an unpinned snapshot with `E_TWIN_COLLAPSE_RECOVER` and
  writes nothing.
- `--pin-snapshot` pins it first, then recovers. Pinning writes only the
  snapshot's `.meta.json` sidecar, never the snapshot.
- The check runs before the store opens, because a collapse run while the store opens may pin the snapshot
  on its own.

Backup rotation never deletes a pre-collapse snapshot that a twin-collapse
marker references, whether it is pinned or not; 2026.9.21 wrote some without
a pin. Such a snapshot does not count toward the rotation cap. If a marker
cannot be read (malformed, or the store busy), every `migration` backup is
kept and a warning is logged. Other backup types still rotate, and
`cleo doctor` names the unreadable marker (T12770). Every store open still pins the
marker's snapshot, creating its sidecar when there is none, and it only
writes that sidecar once.

A `focus_state` that only the twin held (the kodomeet shape), which 2026.9.21
deleted outright, has its session notes restored when the store has had no
`focus_state` since. Its `currentTask` pointer is not restored: a bound session
would adopt a months-old pointer (T12771), so the full value stays in the
archive. When one was written since, the twin's notes are merged into it. In both
cases the twin value is also archived, and `--rollback` undoes it.

Recovery receipts stay as their own append-only
`twin_collapse_recovery:<recoveredAt>` keys rather than in the collapse marker.
The marker is rewritten on every collapse, so a receipt stored there could be
overwritten, and the #1714 review required receipts that are never overwritten.

A re-run on an already-recovered store is a no-op whatever the pin
(T12772). `--recover` and `--pin-snapshot` refuse a marker that names a
snapshot outside the store's own `.cleo/backups/sqlite/`.
