---
id: nexus-base-freshness
tasks: [T14007]
kind: feat
summary: NEXUS freshness reports how many commits the index trails the base branch, and its age
---

Index freshness (`cleo nexus status`, and the freshness block every graph
query discloses) now carries `indexedRevision`, `baseRef`, `baseRevision`,
`commitsBehind` and `ageDays`. `commitsBehind` is counted against the base
branch (origin's default branch, else a local `main`/`master`, else `HEAD`),
never the working tree, so a checkout on an old branch can no longer make a
stale index look fresh. The human `nexus status` shows both.

Origin's default branch is now resolved in one place (`git/base-ref.ts`)
instead of three copies.
