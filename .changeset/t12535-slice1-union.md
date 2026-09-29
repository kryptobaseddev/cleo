---
id: t12535-slice1-union
tasks: [T12535]
kind: fix
summary: Twin collapse never drops a twin-only or replaced value; collapse snapshots are pinned
---

The initial collapse of `schema_meta` and `sticky_tags` no longer drops what only
the prefixed twin holds. Twin-only keys and sticky tags are carried over and
listed as `kept`. When a key's twin value would be replaced, it is copied to
`twin_collapse_archive:<key>` in `tasks_schema_meta` and listed as `archived`
(`cleo doctor` shows the keys). `focus_state` merges instead: the live value's
current fields win, and the session-note history is the union of both,
deduplicated and sorted. The snapshot a twin collapse takes before changing the
store is pinned: backup rotation never deletes it, `cleo backup list` marks it,
and snapshots taken unpinned by 2026.9.21 are pinned at the next open. The first
2026.9.24 open of each store applies all of this.
