---
id: t10163-cleo-docs-find-similar
tasks: [T10163]
kind: feat
summary: cleo docs find --similar <slug> — surface llmtxt rankBySimilarity over an existing seed doc
---

Surfaces llmtxt rankBySimilarity through a new CLI surface so agents can ask "what's already been written about X?" before drafting a new doc. New `cleo docs find --similar <slug>` verb with `--limit` (default 10), `--threshold` (default 0.5), and `--all-kinds` (default off — only same-kind hits) flags. Envelope: `{ seedSlug, seedKind, totalCandidates, hits: [{ slug, kind, score, summary, lifecycle_status }] }`. The seed doc is always excluded from its own results; non-text attachments (binary blobs, images) are skipped so their bytes don't pollute the n-gram fingerprint. Core helper `findSimilarDocs` lives in `packages/core/src/docs/docs-ops.ts` alongside the existing `searchAllProjectDocs`/`searchDocs`/`rankDocs`. Saga T9855 / Epic T10157 / E12.C6.
