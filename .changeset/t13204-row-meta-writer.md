---
id: t13204-row-meta-writer
tasks: [T13204]
kind: refactor
summary: One shared writer for sync row meta (upsertRowMeta, nextFhlc), used by the sealer and ready for the apply engine
---

The sealer's private `_sync_row_meta` upsert and its `fhlc` rule move into `store/sync/row-meta.ts`. That module exports `readRowMeta`, `upsertRowMeta`, `nextFhlc` (the sealer rule, unchanged), `compressFieldHlcs`, `fieldHlcsOf`, and `upsertRowMetaFromFields`. The last one takes a row's full per-field HLC map, as the apply engine (T12344) produces after a merge, and writes the newest as `hlc` and only older fields as `fhlc` (spec §1.6). The sealer and the apply engine can no longer compress field HLCs differently. Sealer behaviour is unchanged.
