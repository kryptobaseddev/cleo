---
id: writer-worker-drain
tasks: [T14069]
kind: fix
summary: "the brain writer worker finishes its scheduled embeddings before it is terminated, so stopping it never aborts the host process"
---

The brain writer worker embeds each new observation inline, which loads
`@huggingface/transformers` and its native onnxruntime addon. Shutting the
writer down terminated the worker at once. A termination that landed while
the addon was loading or running aborted the whole process with
`terminate called after throwing an instance of 'Napi::Error'`. On CI this
killed the vitest fork running `brain-writer-thread.test.ts` ("Worker exited
unexpectedly" on ubuntu shard 4, with every test passing).

The manager now asks the worker to drain before terminating it
(`drainAndTerminateWriter`, waiting at most 10 s). The worker finishes the
ops queued so far and the embeddings they scheduled
(`drainScheduledEmbeddings`), starts no new ones, then answers. The test uses
the same path.
