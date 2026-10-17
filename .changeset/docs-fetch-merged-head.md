---
id: docs-fetch-merged-head
tasks: [T13842]
kind: fix
summary: docs fetch now returns the merged head after concurrent edits, not the last writer's raw input
---

`docs update` wrote the doc row (what `docs fetch` and `docs view` read)
from the incoming bytes, then projected the edit through the section CRDT.
After a stale-base merge the conduit head held both writers' edits, but the
row held only the last writer's input, so readers lost the other edit even
when the merge itself was correct. The merge is now previewed first (the
real projection, rolled back), the row is written from the resulting head
text (the merged text when the write advances the head, the current head's
text when it loses the head race), and the projection is committed only
after the row write succeeds, so a failed blob or row write never leaves the
head advanced over an old row. A failed preview writes the incoming bytes and
leaves the head unchanged; a failed commit after the row write is reported
with the head uid (`W_DOC_PROJECTION_FAILED`). The body schema is checked on
the merged text.
