---
id: t13397-collision-rekey
tasks: [T13397]
kind: feat
summary: "Sync settles a held uid collision: the loser's origin re-keys it and every replica follows"
---

A uid collision held by apply (T13394) now settles on its own. The replica that
authored the losing row (the greater birth fingerprint) re-keys it to a fresh
uid in a local `rekey` frame, so the K is journaled and pushed, and the held
winner then places under the freed uid. A replica that holds the loser records
the K as an alias in the new local-only `_sync_uid_alias` table (both stores),
and the held insert follows it to the new uid and applies. References the
origin wrote to its loser before its K follow the alias; references written
after it, or by anyone else, mean the winner. While a collision is open, an op
that references the contested uid waits instead of binding to the wrong row.
A settled collision's conflict is marked resolved.

An insert whose display id (local key) is held by another row is now held as
a `key-collision` conflict instead of being voided by the UNIQUE constraint
(T12341 §6.4 step 7). Two tasks that collide on uid also share their display
id, so they stay held until a display-id re-mint frees it.
