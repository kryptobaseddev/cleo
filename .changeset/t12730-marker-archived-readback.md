---
id: t12730-marker-archived-readback
tasks: [T12730]
kind: fix
summary: a twin-collapse marker an older build rewrote without its archived list reads the list back from the archive keys
---

2026.9.21 to 9.23 rewrite the `twin_collapse:<table>` marker on an incremental merge without the `kept`/`archived` lists 9.24 added. On a machine mixing those builds, the list naming the archived twin values was lost, and the next 9.24 merge wrote the empty list back. A marker without an `archived` list now reads it from the archive keys themselves (`twin_collapse_archive:<key>` in `tasks_schema_meta`, the rows under `twin_collapse_archive:sticky_tags` in `brain_schema_meta`), so `cleo doctor` keeps naming them and the next merge restores the list. A pinned pre-collapse snapshot an older build rotated away is reported by `cleo doctor` as missing (#1707).
