---
id: t12727-twin-collapse-recover
tasks: [T12727]
kind: fix
summary: cleo doctor twin-collapse --recover restores what a 2026.9.21 collapse dropped or replaced
---

`cleo doctor twin-collapse --recover` reads the pre-collapse snapshot that the
collapse marker records, opened read-only and never modified. It copies every
twin `schema_meta` value that 2026.9.21 dropped or replaced into
`twin_collapse_archive:<key>`, merges the twin's `focus_state` session notes
into the live value (live fields win; notes deduplicated by timestamp and text,
then sorted), and archives twin-only sticky tags under
`twin_collapse_archive:sticky_tags`. An existing archive key is never
overwritten; the value goes under a suffixed key instead.

`--dry-run` prints the exact plan and writes nothing. An apply writes a
`twin_collapse_recovery` receipt in one transaction. It is idempotent, so a
second run finds nothing to do, and it needs no network. When the snapshot is
missing, the command says so, changes nothing and exits 1.
