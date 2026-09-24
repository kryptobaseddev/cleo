---
id: split-brain-import
tasks: [T12329]
kind: feat
summary: "`cleo doctor split-brain` imports rows that exist only in a diverged copy of a store into another copy, under newly minted task ids with provenance. It is dry-run first and proves that no pre-existing row changed."
---

A project copied to a second path keeps its projectId and its store, and
both copies keep allocating from the same counter. cleocode's checkout was
rsynced to `/home/keatonhoskins/cleocode` on 2026-09-14. Since then,
T12188–T12202 name different work in each store, and 11 observations exist
only in `/home`.

`cleo doctor split-brain --source <db> --target <db>` works as follows:

- **Finds the divergence point.** It is the newest `created_at` among tasks
  that are identical in both stores. Every timestamp comparison is parsed,
  because `datetime('now')` text sorts before ISO text within a day.
- **Imports source rows written after that point.**
  - Every imported task gets a newly minted id, above both the sequence
    counter and the maximum stored id (the lower bound
    `allocateNextTaskId` uses). The live allocator continues past the
    imported ids without a counter write.
  - The task's acceptance criteria get ids re-derived with `buildAcRowId`.
    Its AC history, dependencies, relations, labels, work history, commit
    links and audit rows follow it with remapped ids.
  - Sessions, brain observations, decisions, learnings and patterns, the
    operation audit log, releases and changesets, evidence bindings, and
    memory links keep their ids, which are absent from the target. Their
    task references are remapped.
- **Does not resurrect rows the target deleted.** A source-only row written
  before divergence is counted as deleted in the target and not imported.
- **Reports, never silently drops.** Telemetry and derived data (the brain
  graph, usage and token logs), parent-owned child projections on parents
  that are not imported, and any post-divergence row in a table the import
  does not handle are each reported with a count and a reason.
- **Records provenance.** Each imported entity gets a `tasks_audit_log` row
  with action `split_brain_import`, its original id, the new id and the
  source store. Each imported task also gets a note naming its original id.
- **Writes in one transaction.** The target is written in one `BEGIN
  IMMEDIATE` transaction, and only with `--apply`. Any failure rolls back.
- **Proves nothing changed.** `--verify-before <snapshot>` checks, with
  `EXCEPT`, that every row of every ordinary table in the pre-import
  snapshot is still present and byte-identical.
