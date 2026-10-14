---
id: t13716-no-implicit-model-download
tasks: [T13716]
kind: fix
summary: The local embedding model downloads only after brain.embedding.allowModelDownload is set; session end no longer reaches huggingface.co
---

The session-end snapshot worker's embedding backfill loaded the local
embedding model, and with no cached copy transformers.js downloaded it from
huggingface.co and its AWS-hosted CDN. That is a connection CLEO made without
being asked.

The model load in `memory/embedding-local.ts` is the single place the model is
fetched, and it now passes `local_files_only` unless
`brain.embedding.allowModelDownload` is true (default false). A cached model
still loads, so existing users with the model on disk keep their embeddings.
An uncached model latches as unavailable for the process, the backfill skips
its rows, and a debug line names the opt-in:
`cleo config set brain.embedding.allowModelDownload true --type boolean --scope global`.
