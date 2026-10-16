---
id: vault-journal-coexistence
tasks: [T12999]
kind: fix
summary: cloud push checkpoints the change journal; cloud verify compares a journal store with the journal tallies
---

On a stream the change journal writes, `cleo cloud verify` compared the store
with the head snapshot's frozen counts. Journal streams take no new snapshots,
so every synced store reported `ahead` (the Stage C staging gate).

With `sync.push` on, `cleo cloud push` now seals, pushes and pulls the journal,
then writes a checkpoint/v3 at the snapshot's pull position. Its counts reconcile
through the window's journal tallies (pending and voided transactions), never a
synthetic delta segment. The snapshot is checked to hold exactly the sealed and
pushed state: a write that lands between the sync and the snapshot makes the
push sync and snapshot once more, then refuse, so it is never recorded as a
voided effect. Files and other databases, which the journal never carries, are
snapshot-authoritative on the server (cleo-nexus #44); a server without that
rule refuses the checkpoint, and the push says so instead of writing a delta.
A checkpoint carries only its unresolved inbox rows, and a restore keeps them, so
its pending transactions still apply, once. A device whose last synced snapshot
is older than the head, when the head changed files or databases, is refused as
behind; `--force` pushes a labelled fork. On such a store `cleo cloud pull`
brings in only the snapshot's files and databases (the journal carries
`cleo.db`), records the head as synced, and the push then lands.

`cleo cloud verify` on a store that writes the journal compares each table's
rows with the head's counts plus the journal's tallies past it, and reports
`behind` or `ahead` from the store's pull position and unpushed changes. A store
without the journal, or with `sync.push` off, behaves as before.
