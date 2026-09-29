---
id: t12727-recover-pin-kodomeet
tasks: [T12727]
kind: fix
summary: twin-collapse --recover reports and refuses an unpinned snapshot (--pin-snapshot), and restores a twin-only focus_state
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

A `focus_state` that only the twin held (the kodomeet shape), which 2026.9.21
deleted outright, becomes live again when the store has had no `focus_state`
since. When one was written since, the twin's notes are merged into it. In both
cases the twin value is also archived, and `--rollback` undoes it.

Recovery receipts stay as their own append-only
`twin_collapse_recovery:<recoveredAt>` keys rather than in the collapse marker.
The marker is rewritten on every collapse, so a receipt stored there could be
overwritten, and the #1714 review required receipts that are never overwritten.
