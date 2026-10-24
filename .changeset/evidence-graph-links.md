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

File nodes are keyed by the path relative to the evidence repository, in POSIX
form (`./a.ts`, `a.ts` and an absolute path inside the repo are one node); a
path outside the repository gets no node and is named in the warning. File and
decision links are written in one brain transaction, an existing commit node is
never rewritten by a later verify, and a failed commit link raises the warning
instead of being logged and counted.
