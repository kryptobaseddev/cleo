---
id: embed-all-memory-tables
tasks: [T13740]
kind: feat
summary: Vector search embeds decisions, learnings and patterns too, and every vector records its model
---

Only observations were embedded, so rank fusion pushed decisions, learnings
and patterns below observations that matched on both legs. The embedding
backfill and the write-time embed (long-lived hosts) now cover all four memory
tables.

Each vector stores the model that produced it (`Xenova/all-MiniLM-L6-v2@main:fp32`,
the pipeline now pins that revision and dtype). Similarity search, supersession
and surprisal compare only vectors of the current model, and the backfill
re-embeds any row whose vector came from another model. A vector table from
before the tag is rebuilt on open: its vectors named no model, and they are
local derived data that the backfill recomputes.

Re-embedding an existing row also works now: vec0 rejects `INSERT OR REPLACE`
on its primary key, so the upsert deletes the old vector first.
