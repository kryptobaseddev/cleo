---
id: sleep-merge-reads-brain-embeddings
tasks: [T14599]
kind: fix
summary: "sleep consolidation merges near-duplicate memories again: it reads vectors from brain_embeddings, and a failure is reported in the result"
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
