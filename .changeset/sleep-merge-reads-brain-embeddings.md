---
id: sleep-merge-reads-brain-embeddings
tasks: [T14599, T14639]
kind: fix
summary: "sleep consolidation merges near-duplicate memories again, one transaction per pair with a reversible supersedes link, and reports failures in the cleo memory dream result"
---

The near-duplicate merge step of sleep consolidation selected an `embedding`
column that `brain_observations` does not have and swallowed the resulting
error, so it never merged anything.

- The step now joins `brain_embeddings` and compares only vectors of the
  current embedding model, the same way the dreamer step reads them.
- Vectors are read from the `Uint8Array` node:sqlite returns, not through
  `Buffer` methods it lacks.
- A failure of the step is reported in `mergeDuplicates.error` of the
  consolidation result instead of reading as "nothing to merge".
- Each pair merges in one transaction: the evicted row is invalidated, its
  citations move to the kept row, and a `supersedes` edge from the kept node
  to the evicted node records the similarity, the citations moved and the
  `invalid_at` set, which is everything needed to reverse the merge. A failed
  pair rolls back, leaving both rows unchanged, and is counted in
  `mergeDuplicates.failed`.
- `cleo memory dream` reports `sleepConsolidation.mergeFailed` and
  `sleepConsolidation.mergeError`.
