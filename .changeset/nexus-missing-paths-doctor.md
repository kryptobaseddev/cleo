---
id: nexus-missing-paths-doctor
tasks: [T14021, T13922]
kind: feat
summary: "Graph answers report indexed files gone from disk, and `cleo doctor --all-projects` flags stale NEXUS indexes per project"
---

`nexus impact`, `nexus context` and every other index-sensitive answer now
carry `missingFileCount` and a sample of `missingPaths` in `data.freshness`:
indexed files that no longer exist on disk, such as the files of a deleted
clone. When any exist, the answer warns with `W_NEXUS_INDEX_MISSING_PATHS`,
since its results may cite deleted code. Files only excluded since indexing
still count as stale but not as missing.

`cleo doctor --all-projects` (and `cleo doctor-projects`) now reports each
project's code index as `nexusIndex`: when it was built, its age, the indexed
revision, commits behind the base branch and HEAD, and the indexed files no
longer on disk. A project's index is flagged stale when it is further behind
HEAD than `nexus.freshness.maxCommitsBehind` or holds missing files. The flag
appears as an issue line but leaves the project's overall health unchanged. The
probe is read-only and does no walk: it opens the project's `cleo.db` as a
read-only snapshot, never through the migrating store. A project that was never
indexed is not flagged.

The filesystem walker's skip of nested repositories is now also pinned for a
linked worktree or submodule whose `.git` is a file.
