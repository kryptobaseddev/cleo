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

Every CLEO model load (the embedding model and the transcript extractor's
text-generation model) now goes through one gate, `importGatedTransformers`
in `memory/embedding-local.ts`. It sets transformers.js's process-global
`env.allowRemoteModels` from `brain.embedding.allowModelDownload` (default
false) and the loaders pass `local_files_only` to match; `local_files_only`
alone was not enough, because transformers.js 4.0.1 still fetches config and
tokenizer metadata from the hub during file discovery. A cached model still
loads, so users with the model on disk keep their embeddings. An uncached
model latches as unavailable for the process, the backfill skips its rows,
and a debug line names the opt-in:
`cleo config set brain.embedding.allowModelDownload true --type boolean --scope global`
(restart the CLEO process to apply it). The embedding backfill and observe
path also honour `brain.embedding.enabled: false`, and the global config
template carries `"allowModelDownload": false`.
