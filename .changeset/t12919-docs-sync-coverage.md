---
id: t12919-docs-sync-coverage
tasks: [T12919]
kind: feat
summary: "Docs reach a second device: the doc registry and its owner refs get row uids and sync"
---

`docs_attachments` and `docs_attachment_refs` now carry row uids, so their
capture triggers exist and a doc added on one device lists on another after
`cloud sync`. Before this, neither table had a uid, so neither was captured and
the Stage C gate found docs never reached device B. A doc row is minted from its
id and creation time, and its supersession pointers travel as uids. A ref is a
UUIDv8 over its primary key. Concurrent lifecycle changes merge under the
`docs.lifecycle.transitions` rule, so `superseded` is never undone. The
migration `20261014100000_t12919-docs-row-uids` adds the columns and unique
indexes.

`docs_wikilinks` is now derived and no longer syncs. Each device rebuilds it
from the synced doc rows' supersession, related-task and topic columns.

Known gap: the document bytes in `.cleo/blobs` do not travel on the stream yet
(T13721). On the receiving device, `docs fetch` reports that the content is
missing until a vault restore places the bytes.
