---
id: nexus-stale-exit
tasks: [T14008, T13922]
kind: feat
summary: "Graph answers carry `data.freshness` and fail with E_NEXUS_INDEX_STALE (exit 111) when the index is too far behind the base branch"
---

Every index-sensitive `cleo nexus` answer now returns `data.freshness`
(`status`, `indexedRevision`, `baseRef`, `commitsBehind` to the base branch,
`commitsBehindHead`, `ageDays`, `lastIndexedAt`) instead of burying it in
`meta`. When the index trails the checked-out HEAD by more than
`nexus.freshness.maxCommitsBehind` (default 50), or the queried symbol is
missing from an index that is stale for this checkout (it may exist in code the
index never saw), the answer fails with `E_NEXUS_INDEX_STALE` and exit code
111. Distance to the base branch is reported, never refused on: a feature
branch or worktree reindexed where it stands answers normally.
`error.fix` names the reindex command (`cleo nexus analyze "<root>"`).
`--allow-stale` on `nexus impact` and `nexus context`, or
`CLEO_NEXUS_ALLOW_STALE=1` for any graph query, accepts the stale answer.
