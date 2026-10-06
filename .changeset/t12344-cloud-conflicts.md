---
id: t12344-cloud-conflicts
tasks: [T12344]
kind: feat
summary: "`cleo cloud conflicts` lists the sync conflicts this store's apply recorded, and `cleo cloud conflicts resolve <id>` marks one resolved"
---

This is the sixth slice of the apply side (T12344, PR-6 of 6), against journal spec §3.2 ("conflict records … never silently dropped").

- **`cleo cloud conflicts`** lists open conflicts by default, oldest first. `--all` includes resolved ones, `--stream` narrows to one
  stream, and `--scope project|global` picks the store.
  - It covers every conflict an apply records: typed-rule refusals and overrides, edits of deleted rows, deletes over newer edits,
    divergent edits, dangling references, guard refusals, parent deletes with live children, uid collisions and post-apply invariants.
  - The envelope carries `{ scope, open, total, conflicts, warnings }`. A store that has never applied a stream reports
    `W_SYNC_NOT_ENABLED`.
- **`cleo cloud conflicts resolve <id>`** marks an open conflict resolved, once its resolution (an ordinary write) is made or the
  conflict was reviewed.
- Both commands are local only: no request leaves the machine.
- The result types live in `@cleocode/contracts` (`CloudConflict`, `CloudConflictsResult`, `CloudConflictResolveResult`). The core
  reads are `nexusCloudConflicts` and `resolveNexusCloudConflict` in `cloud/nexus-cloud-conflicts.ts`.
