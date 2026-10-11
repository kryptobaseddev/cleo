---
id: t13351-t13352-docs-correctness
tasks: [T13351, T13352]
kind: fix
summary: docVersion advances on every docs update; docs fetch/view envelopes carry decoded text, real refCount, and store-correct paths.
---

`docs-update.ts` read `oldRow.doc_version` from a camelCase Drizzle row, so every update persisted `docVersion = 1` while reporting 2 — all four sites now read `oldRow.docVersion` and persist `+ 1`, including the dedupe branch that never set it. `docs fetch` and `docs view --json` share one core builder: text docs carry decoded `content` (no base64 round-trip; binary keeps `bytesBase64`), `refCount` is the real value, and `path` resolves against the doc's actual backing store (`.cleo/blobs/blobs/<sha>` for manifest-db docs).
