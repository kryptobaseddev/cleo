---
id: sync-timestamp-echo-conflict
tasks: [T13714]
kind: fix
summary: a replica's own echo no longer records field conflicts on timestamps stored as legacy 'YYYY-MM-DD HH:MM:SS' text
---

The sealer sends every captured timestamp in canonical ISO form
(`2026-10-14T17:32:57.000Z`), but local rows are never rewritten after genesis,
so a column stamped by SQLite's `datetime('now')` keeps `2026-10-14 17:32:57`.
The merge compared the op's canonical before- and after-values with that raw
text, saw neither match, and recorded an `incoming-dropped` field conflict on
the replica's own echo. `cloud conflicts` then listed conflicts on one device
that the other never had.

The applier now reads captured timestamp columns in the form the sealer sends,
as it already reads references as their target's uid. Local rows keep their
text; no migration is needed.
