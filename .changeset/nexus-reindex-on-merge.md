---
id: nexus-reindex-on-merge
tasks: [T14010]
kind: feat
summary: "Opt-in background NEXUS reindex after a merge into the base branch (`nexus.reindexOnMerge.enabled`)"
---

CLEO installs a fourth managed git hook, `post-merge`, which starts
`cleo nexus reindex-on-merge` in the background and never blocks the merge. The
command does nothing unless `nexus.reindexOnMerge.enabled` is `true`, runs only
when HEAD is on the base branch, runs one at a time per project (a lock under
`.cleo/`), and runs `cleo nexus analyze` through `cleo run --wait --class build`,
so a busy machine defers it instead of adding to the pressure
(`nexus.reindexOnMerge.timeoutSeconds`, default 1800). Each outcome (ran,
skipped, deferred, failed, with its reason and time) is shown by
`cleo nexus status` as `reindexOnMerge`.
