---
id: docs-documents-edge
tasks: [T13985]
kind: feat
summary: a document attached with `cleo docs add` is linked in BRAIN by an `llmtxt:<sha> --documents--> owner` edge, written whatever brain.autoCapture says
---

Owner decision D11180 records document links as a graph edge instead of a
"Doc attached" observation. The docs projection now always writes the
`llmtxt:<sha>` node and its `documents` edge to the owner (task, session,
...). The owner's `embeds` edge stays automatic capture and still follows
`brain.autoCapture`; with it off the projection reports `graph: disabled`
but the canonical link is there.

The internal `memory.backfill-docs` operation writes the missing `documents`
edges (idempotent) instead of emitting observations; its result reports
`written` and `skipped`. The "Doc attached" observation itself is retired in
a follow-up.
