---
id: t12728-focus-union-incremental
tasks: [T12728]
kind: fix
summary: an incremental twin-collapse merge of focus_state keeps every session note on both sides
---

After the initial schema_meta collapse, an older build (2026.9.20/9.21) writing the bare `focus_state` was carried by the incremental re-merge as bare-wins, replacing the twin value and its `sessionNotes` history. The incremental merge now applies the same union as the initial collapse: the notes are the union of both sides, deduplicated by (timestamp, note) and sorted. When only the bare side moved, its current fields win and the replaced twin value is archived under `twin_collapse_archive:focus_state` (or `twin_collapse_archive:focus_state:<sha8>` when the initial collapse already archived one there, so no archive is overwritten), and the marker lists it as archived. When both sides moved, the twin's current fields win and the key is reported as a conflict, as before, but the bare side's notes are no longer lost.
