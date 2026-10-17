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
when the merge itself was correct. The projection now runs first and the row
is written from the resulting head text: the merged text when the write
advanced the head, the current head version's text when it lost the head
race. The incoming bytes are written only when the projection fails.
