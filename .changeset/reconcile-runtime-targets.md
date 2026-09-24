---
id: reconcile-runtime-targets
tasks: [T12346]
kind: fix
summary: "Reconcile now copies each legacy row into the table the runtime reads, worked out from the runtime's own table definitions; the lineage rebuild verifies that every prior row is restored"
---

**Rows go where the runtime reads them.** The exodus table map sends every
legacy task-family table to its `tasks_*` counterpart. The runtime has only
switched part of that family over. It binds the tasks domain through
`tasks-schema.ts`, which points `tasks`, `sessions`, `lifecycle_*`,
`releases`, `commits`, `task_*` and a few others at `tasks_*`. It still reads
and writes `audit_log`, `token_usage`, `architecture_decisions`,
`adr_task_links`, `attachments`, `schema_meta`, `status_registry` and
`pipeline_manifest` under their old names.

Reconcile had been copying those rows into `tasks_*` tables that nothing reads.
The new `buildRuntimeTargetResolver` (`exodus/runtime-targets.ts`) works out
each target from the table objects the runtime actually binds, not from a
hand-written map. For every export of the old schema module (`schema/index.ts`,
whose table names are the old `tasks.db` names), the target is the table name
of the same export as `tasks-schema.ts` defines it. If the runtime later moves
another table to `tasks_*`, the target follows automatically.

- Folded tables (`release_manifests` → `releases`) go to wherever the runtime
  reads the table they were folded into.
- Value conversions still use the consolidated table names.
- Reconcile opens the tasks domain before copying, so every target table
  exists first.

The set of old tables the runtime no longer reads is also computed this way.
When reconcile reads that set from an unmigrated `cleo.db`, it drops the rows
the `drizzle-tasks` lineage adds to every new store (for example its 18
backfilled `commits`). Those rows are not project data, and a new project
keeps them only in the unprefixed table.

The new test reconciles a fixture and reads the history back through the real
runtime functions: `getLifecycleStatus` shows the legacy pipeline's stage as
completed, and `queryAudit` returns the legacy audit row. With the old
consolidated targets, the same test fails.

**The rebuild's copy-back is now verified.** After the `drizzle-tasks` table
set is rebuilt, every snapshot row of every dropped table has to be in the
recreated table, or the rebuild throws and rolls back.

- Rows go back unchanged: guard triggers are paused during the copy,
  `ignore_check_constraints` is on, a snapshot row replaces a same-key default
  row, and NOT NULL columns the old table lacked get their type default.
- A table the rebuilt set folds away (`release_manifests`) is copied into the
  table that absorbs it, using that fold's conversion and version check.

On claude-todo, all 15 dropped tables come back in full, including the 5,330
unused `tasks` rows that were previously left only in the snapshot.

**Sweep:** on copies of all 18 projects with legacy data, 17 reconcile
completely. Each of those projects' legacy rows is present in the table the
runtime reads. The runtime functions return them, for example claude-todo
`queryAudit` 14,880/14,880 and `getLifecycleStatus` 45/45 pipelines.
