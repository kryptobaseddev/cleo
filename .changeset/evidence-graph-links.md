---
id: evidence-graph-links
tasks: [T13950]
kind: feat
summary: "`cleo verify` links a task to the commits, files and decisions its accepted evidence names, in the BRAIN graph"
---

When `cleo verify` accepts evidence atoms for a gate, the atoms it already
validated become graph edges: `commit:` (and a `pr:` atom's merge commit)
gives `task --touches_code--> commit:<sha>`, `files:` gives
`task --touches_code--> file:<path>`, and `decision:` gives
`decision --applies_to--> task`. Writes do not depend on `brain.autoCapture`
and are idempotent, so re-verifying adds nothing. They run after the
verification is committed: a graph failure leaves the verify successful with a
`W_EVIDENCE_GRAPH_LINK_FAILED` warning.
