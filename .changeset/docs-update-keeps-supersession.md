---
id: docs-update-keeps-supersession
tasks: [T14565]
kind: fix
summary: "cleo docs update on a doc that supersedes another (or is superseded) keeps the supersession on both docs, and docs fetch lineage lists every doc a survivor replaced (predecessors)"
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
  rollback purges. A doc superseded since the update keeps its superseded
  status and successor together, so a rollback cannot make it editable again.
- After concurrent updates on two devices, lineage and wikilinks resolve a
  version row's pointer through its doc identity, including a version that
  yielded its slug during sync collision settlement.
- Version rows give up their supersession pointers when the slug moves. A
  new doc that reuses an old version's bytes starts with no supersession.
- `cleo docs fetch <slug>` lineage has a new `predecessors` list: every doc
  this one replaced. The `supersedes` pointer holds one doc, so a survivor that
  replaced several named only the latest; the list is read from the replaced
  docs, each of which names its successor. It needs no store change: existing
  supersessions show both sides as soon as this version is installed.
- An edge already lost on the superseded doc's side (its `supersededBy` reads
  null) is repaired by running `cleo docs supersede <old> <new>` again; it now
  stays through later updates.
