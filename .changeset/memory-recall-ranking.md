---
id: memory-recall-ranking
tasks: [T13948]
kind: feat
summary: memory find ranks one list across tables by recency and source, fuses vector and graph hits, and warns when the vector layer is unavailable
---

`cleo memory find` used to return a fixed per-type quota (decision, pattern,
learning, observation, repeat) ordered by BM25 inside each table, with no
notion of age or authorship. Each full-text hit now scores
`1/(1+rank) x recency x source`: recency decays from 1 to a 0.5 floor with a
60-day half-life, and source ranks owner > task outcome > agent >
speculative. The result is fused with vector and graph hits by reciprocal
rank fusion, so a vector-only or graph-only hit can now appear in results.

A missing vector layer is no longer silent: the envelope carries a
`W_MEMORY_VECTOR_UNAVAILABLE` warning that names the missing piece (no
provider, no vector, sqlite-vec not loaded, no embeddings for the model, or a
query error).

**Behaviour change:** `cleo memory search-hybrid` keeps graph neighbours only
when they are memory rows (decision, pattern, learning, observation); task,
concept and doc nodes reached through the graph are no longer returned.
