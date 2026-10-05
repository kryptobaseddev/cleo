---
id: t13246-writer-isolate-flag
tasks: [T13246, T13230]
kind: fix
summary: only the brain writer isolate writes an observe-time embedding directly; any other worker thread goes through the chokepoint
---

Before this fix, `observeBrain` wrote its deferred embedding straight to its own store handle in
**any** worker thread (`!isMainThread`). `CLEO_BRAIN_WRITER_THREAD=1` carries into every worker's
environment, so a future worker that observes, but is not the writer, would have written
`brain_embeddings` outside the lease and the mutex.

Now the brain writer worker declares itself with `markBrainWriterIsolate()`. Only that isolate
writes directly. Every other context sends an `embed` op through `enqueueBrainWrite`.
