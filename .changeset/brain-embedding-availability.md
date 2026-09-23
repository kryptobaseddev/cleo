---
id: brain-embedding-availability
tasks: [T12129]
kind: fix
summary: BRAIN embedding availability is capability, not "has already run" — breaks the deadlock that made local embeddings entirely inert (gh#1217)
---

`LocalEmbeddingProvider.isAvailable()` returned `_ready`, the "pipeline has
loaded" flag. `_ready` is set only by `loadPipeline()`, which runs only inside
`embed()` — and every caller of `embed()` checks `isAvailable()` first. In any
fresh CLI process `_ready` is false, so nothing ever called `embed()`, so
`_ready` never became true. **The readiness check could only be satisfied by
the call it guarded.**

It failed silently and completely: `cleo brain maintenance` reported
`{processed: 0, skipped: 0, errors: 0}` on every run, `brain_embeddings` stayed
empty after dozens of observations, new writes were never embedded, and every
hybrid search degraded to FTS5 — all while `brain.embedding.enabled` was true
(a shipped default) and the provider itself worked perfectly when invoked
directly.

Availability now means capability: the provider can load its pipeline on
demand and says so until a load actually fails. The ~22 MB first-call download
is the expected cost of the lazy design, not a reason to refuse to begin. A
failed load latches, so there is no retry loop, and `embedText` returns `null`
on failure so callers degrade to FTS5 rather than rejecting a search or raising
an unhandled rejection on the fire-and-forget write path.

An inactive backfill now reports `inactiveReason` and emits a
`W_EMBEDDINGS_UNAVAILABLE` warning. A bare zero result is indistinguishable
between "everything is already embedded" and "this feature is off or broken",
and for the whole of this bug it silently meant the latter.

The `EmbeddingProvider` interface now states that implementations must not
report availability as "has already produced one", since that is the shape of
the deadlock.
