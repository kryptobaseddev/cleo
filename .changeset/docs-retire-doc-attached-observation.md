---
id: docs-retire-doc-attached-observation
tasks: [T13985]
kind: feat
summary: `cleo docs add` no longer writes a "Doc attached" memory observation; the document is linked by its documents edge
---

Owner decision D11180 retires the "Doc attached" observation that T9976 added
(T9976 AC1). The docs projection now records only the graph link,
`llmtxt:<sha256> --documents--> owner`, and its receipt carries
`documents: true` instead of an `observationId`. Receipts of projections that
completed before this change still parse and still verify against the
observation they name.

Documents are found through `cleo docs` (`list`, `find`, `fetch`). Legacy
"Doc attached" rows stay out of memory recall, and `cleo memory verify` still
round-trips one against the docs store.
