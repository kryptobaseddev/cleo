---
id: t12998-cloud-status-sync
tasks: [T12998]
kind: feat
summary: cleo cloud status shows each store's local sync journal (flags, unsealed ops, last sealed seq, quarantine, suspect tables); server-side sync fields are reported as unknown with the reason
---

`cleo cloud status` (JSON `data.sync`, and a one-line summary) now reports one stream
per store, for the project and the global store:

- whether the sync journal is installed;
- the `sync.capture` / `seal` / `push` / `pull` / `strict` flags;
- how many captured ops are not sealed yet, and since when;
- the last sealed local sequence;
- quarantined rows per table;
- tables marked suspect.

It is read-only: the store is opened as a snapshot with no migrations, and an
unreadable store is a warning, never a failure.

This is a partial build (`partial: true`). The fields that need pieces not built yet
are reported as `{ known: false, needs, reason }` instead of a guess:

- unsent ops need the transactional outbox (T12343);
- the last pushed and pulled sequence, the server head, devices, open conflicts and lag
  need segment push/pull (S4).
