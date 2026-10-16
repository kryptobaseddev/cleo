---
id: t12919-docs-sync-coverage
tasks: [T12919]
kind: feat
summary: "Docs reach a second device: the doc registry and its owner refs get row uids and sync"
---

`docs_attachments` and `docs_attachment_refs` now carry row uids, so their
capture triggers exist and a doc added on one device lists on another after
`cloud sync`. Before this, neither table had a uid, so neither was captured and
the Stage C gate found docs never reached device B. A doc's row uid is derived
from its sha256, so the same bytes added on two devices (the same ADR backfilled
on each machine) become one doc instead of one device losing its row to the
UNIQUE index; each device keeps its own local id, and references travel as uids.
A ref's uid is derived from its doc's uid and owner, so a ref to a doc deleted
elsewhere is recorded as a dangling ref, never written as an orphan. Two
different docs added under one slug both survive: the row with the greater uid
yields the slug as `<slug>-<8 hex>` on every device, with a recorded conflict.
Concurrent lifecycle changes merge under the `docs.lifecycle.transitions` rule,
so `superseded` is never undone. A rebase that restores a row's local key now
moves the references written meanwhile with it. The migration
`20261014100000_t12919-docs-row-uids` adds the columns and unique indexes.

The same doc now has a different local attachment id on each device, so refer to
docs by slug across devices.

`docs_wikilinks` is now derived and no longer syncs. Each device rebuilds it
from the synced doc rows' supersession, related-task and topic columns.

Known gap: the document bytes in `.cleo/blobs` do not travel on the stream yet
(T13721). On the receiving device, `docs fetch` reports that the content is
missing until a vault restore places the bytes.
