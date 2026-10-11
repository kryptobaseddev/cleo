---
id: t13394-uid-collision
tasks: [T13394]
kind: fix
summary: "Sync apply never merges two different rows that minted the same uid"
---

When an incoming row op names a uid that a local row already holds with a
different birth fingerprint, the two are different rows that happened to mint
one uid (for example two devices writing retrieval-log id 1 in the same second,
or creating T1 at the same instant). The applier used to merge the incoming
values into the local row. It now holds the incoming transaction (pending) and
records one `uid-collision` conflict (resolution `op-held`) that names the
loser, the greater fingerprint (T12341 §6.4 step 3). The local row's own writes
are not held behind it. A re-key whose old fingerprint names the other row
never moves the local winner. Same-fingerprint deliveries merge as before.
