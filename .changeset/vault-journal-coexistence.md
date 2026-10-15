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
then writes a checkpoint/v3 at the store's pull position. Its counts reconcile
through the window's journal tallies (pending and voided transactions), never a
synthetic delta segment for journal tables. Files and other databases, which
the journal never carries, still reconcile through a delta segment of those
entries alone, and the sealer numbers its next segment after it.

`cleo cloud verify` on a store that writes the journal compares each table's
rows with the head's counts plus the journal's tallies past it, and reports
`behind` or `ahead` from the store's pull position and unpushed changes. A store
without the journal, or with `sync.push` off, behaves as before.
