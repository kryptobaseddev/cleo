---
id: embed-all-memory-tables
tasks: [T13740, T13729]
kind: feat
summary: Vector search embeds decisions, learnings and patterns too, and every vector records its model
---

Only observations were embedded, so rank fusion pushed decisions, learnings
and patterns below observations that matched on both legs. The embedding
backfill and the write-time embed (long-lived hosts) now cover all four memory
tables.

Each vector stores the model that produced it
(`Xenova/all-MiniLM-L6-v2@onnx-sha256:759c3cd2b7fe:fp32`): the version is the
weights' content hash, pinned in full and verified once per model load. A
cached model with any other hash latches embeddings off with a clear message,
and search falls back to FTS5. The hub revision stays `main`, so existing
cached models keep loading. Similarity search, supersession
and surprisal compare only vectors of the current model, and the backfill
re-embeds any row whose vector came from another model. A vector table from
before the tag is rebuilt on open: its vectors named no model, and they are
local derived data that the backfill recomputes.

Re-embedding an existing row also works now: vec0 rejects `INSERT OR REPLACE`
on its primary key, so the upsert deletes the old vector first.

`brain_embeddings` is now classified derived in both scopes (owner decision
2026-10-14, T13729): vectors are a local cache rebuilt per machine from the
synced memory text, never synced. This supersedes the 2026-09-28 ruling that
made them portable-personal and closes the T12918 cache-blob plan. The
pre-tag table rebuild runs under one write lock, and each batch of vector
upserts is one transaction.
