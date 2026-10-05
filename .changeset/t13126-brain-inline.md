---
id: t13126-brain-inline
tasks: [T13126]
kind: fix
summary: cleo memory observe drops from ~710 MB to ~315 MB; no worker isolate or embedding model in one-shot commands
---

Every `cleo memory observe`, which agents run after each completed task, started a
`worker_threads` isolate that opened the store a second time. It also loaded the local embedding
model (`@huggingface/transformers` and onnxruntime) to embed the single new row before exit.

- **Brain writes run inline by default.** The serialization primitive is the cross-process `brain`
  writer lease plus the in-process async mutex, which already guarded the bypass path. Only a
  long-lived host that opts in uses the worker thread, by calling `useBrainWriterThread()` or by
  being launched with `CLEO_BRAIN_WRITER_THREAD=1`. The RPC, HTTP and MCP gateway servers, the
  sentient daemon and the Studio server opt in. A host that forgets is still correct, writing
  inline under the mutex. `CLEO_BRAIN_BYPASS_WRITER_THREAD=1` keeps its warning.
- **One-shot processes no longer embed on observe.** An opted-in host still embeds each new
  observation as it is stored.
- **Embeddings are filled in batches.** A bounded batch (50, newest first, under the governor's
  `background-autonomous` class) runs in the detached `cleo session end` worker and on each
  sentient tick. It reads a pending count first, so it never loads the model when nothing is
  pending. The model now loads once per session instead of once per observe.

**Behaviour change:** a new observation is found by BM25/FTS5 only until the next session end,
host tick or `cleo backfill`. Hybrid search already falls back for rows without a vector.

Measured on the built CLI, one sandbox project, peak RSS of `cleo memory observe`:

| Path | Peak RSS |
|---|---|
| worker isolate plus model (the old default; `CLEO_BRAIN_WRITER_THREAD=1` now) | 730 MB |
| inline plus model | 590 MB |
| inline, no model (the new one-shot default) | 314 MB |

`cleo session end` then embedded the three pending observations in its background worker.
