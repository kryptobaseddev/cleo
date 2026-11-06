---
id: docs-migrate-rekeys-old-recipe
tasks: [T14336]
kind: fix
summary: "docs migrate and cleo upgrade move docs the pre-T14332 migrate imported onto the shared doc identity, so an old-migrate store and an adopting peer settle to one doc"
---

Docs that the docs migrate before T14332 imported keep the natural uid over
their slug and the `docs:migration` conversation. A device that adopts the
same synced doc today mints another identity, so the two copies collided on
the slug and never merged.

- `cleo docs migrate` (and `cleo upgrade`, which runs it) now re-keys each
  such doc onto the identity adopt, `docs add` and the current migrate all
  mint. It does this in the same backed-up harness step as the import, in one
  `rekey` frame. Versions, approvals, heads, slug aliases, the migration
  receipt, the local section state and the contributors rollup move with it.
- An imported version moves to the uid a device migrating today would derive,
  so the history matches across devices.
- Each re-keyed doc returns a receipt: old uid, new uid, and the versions
  moved. The result's `rekeyed` count and the summary report them. A dry run
  counts them and writes nothing.
- A re-run finds nothing left on the old recipe and writes no snapshot.
