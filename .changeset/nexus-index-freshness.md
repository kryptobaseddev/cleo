---
id: nexus-index-freshness
tasks: [T12316]
kind: feat
summary: every code-graph answer says how current the index is, and a query refreshes a slightly stale index inline (≤25 files, 60 s budget) before answering — disclosing that it did
---

Staleness was pull-only: `cleo nexus status` reported `staleFileCount`, but an
`impact` or `context` answer from an index hundreds of commits old carried no
caveat at all — a confident answer about code that no longer exists.

Every graph query (`impact`, `impact-full`, `context`, `full-context`, `why`,
`search-code`/`augment`, `task-symbols`, `task-footprint`, `brain-anchors`,
`clusters`, `flows`, `route-map`, `shape-check`, `query-cte`, `hot-paths`,
`hot-nodes`, `cold-symbols`, `top-entries`) now returns
`meta._nexus.freshness`: `lastIndexedAt`, `fileCount`, `staleFileCount`, a
sample of stale paths, whether the queried symbol's own file is stale, and the
refresh command with an estimate derived from the last recorded run. A stale
answer also carries `W_NEXUS_INDEX_STALE` in `meta.warnings` and a stderr hint;
an index whose freshness cannot be established says so
(`W_NEXUS_INDEX_FRESHNESS_UNKNOWN`) instead of passing as fresh.
`cleo nexus status` includes the same block, and its `staleFileCount` now
counts added files too.

The check reads a compact per-generation file manifest (`path, size, mtime,
hash`, ~0.8 MB here) instead of the published assessment (472 MB on this
repository) and re-hashes only files whose size or mtime changed, so a
checkout or `touch` that changed no bytes is not stale. Measured on this
repository (5,644 files): 0.46–0.65 s per check, most of it the tree walk.

When `0 < stale ≤ nexus.autoRefresh.maxFiles` (25) and the estimate fits
`nexus.autoRefresh.budgetMs` (60 000), the query runs the incremental analysis
first — cancelled at the budget, atomically published — and reports it in
`freshness.autoRefresh`; beyond either bound, or with
`nexus.autoRefresh.enabled: false`, it answers from the stale index and says
why. Measured: a one-file-stale `impact` query refreshed inline in 28.6 s
(estimate 27 s) and answered from a fresh index.
