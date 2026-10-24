---
id: nexus-reindex-on-merge
tasks: [T14010]
kind: feat
summary: "Opt-in background NEXUS reindex after a merge into the base branch (`cleo nexus reindex-on-merge --enable`)"
---

CLEO installs a fourth managed git hook, `post-merge`. It is free when off: in
shell, before starting any process, it requires the `cleo.nexusReindexOnMerge`
git config marker and HEAD on the base branch. `cleo nexus reindex-on-merge
--enable` sets that marker together with `nexus.reindexOnMerge.enabled`
(`--disable` clears both).

When it runs, `cleo nexus reindex-on-merge` is the lowest-priority heavy work on
the machine: one at a time per project (an atomic lock under `.cleo/`), it
never joins the `cleo run` queue, tries admission only when nothing is waiting,
and records `deferred` after `nexus.reindexOnMerge.timeoutSeconds` (default
300). `cleo nexus status` shows the last real outcome (ran, deferred or failed)
as `reindexOnMerge`; skips are not recorded over it.
