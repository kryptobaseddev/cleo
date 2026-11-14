---
id: docs-update-keeps-supersession
tasks: [T14565]
kind: fix
summary: "cleo docs update on a doc that supersedes another (or is superseded) keeps the supersession on both docs; before, the old doc's lineage lost its successor"
---

`cleo docs supersede A B` links the two docs through their registry rows, and
`cleo docs update B` moves B's slug onto a new registry row. The new row
carried no `supersedes` pointer and A still pointed at the slugless old row, so
`cleo docs fetch A` showed `lineage.supersededBy: null` with `currentSlug` back
on A, and B lost `lineage.supersedes`. Re-running the supersede was the only
way to get the edge back, until the next update dropped it again.

- A doc's supersession edges now move with its slug: the row that takes the
  slug takes the doc's pointers, and every doc that names it is re-pointed, in
  the same transaction as the update. The identity rows of both docs are
  mirrored, so `docs fetch`, `docs graph` and the session briefing keep
  following the chain to the current doc.
- `cleo docs modernize --rollback` moves the edges back with the slug when it
  reverts an update, so the superseded doc never points at the row the
  rollback purges.
- Edges already lost on a store are not rebuilt by this change: run
  `cleo docs supersede <old> <new>` once more for each; they now stay.
