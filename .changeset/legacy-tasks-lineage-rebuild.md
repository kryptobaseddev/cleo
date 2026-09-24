---
id: legacy-tasks-lineage-rebuild
tasks: [T12346]
kind: fix
summary: "A cleo.db copied from a high-water-era tasks.db no longer fails every command with `Failed query: INSERT INTO architecture_decisions_new`; release_manifests history lands in tasks_releases"
---

In claude-todo, every `cleo` command failed at open. `cleo.db` in that project
started as a copy of its pre-consolidation `tasks.db`: every bare table matches
that file row for row. Its migration journal was written by the old migrator,
which recorded only the latest applied migration and treated everything older
as done. It lists the initial migration plus a few later ones. The 40
migrations in between never ran, so the tables and columns they create never
existed.

Drizzle 1.x picks pending migrations by name, so it replays those gaps against
a schema they were never written for:

- `t033` rebuilds `architecture_decisions` with a self foreign key. The legacy
  row `ADR-006.supersedes_id = 'ADR-001'` was already dangling, and its
  `PRAGMA foreign_keys=OFF` does nothing inside drizzle's transaction, so the
  copy fails with `FOREIGN KEY constraint failed`.
- With enforcement lifted, `t033` rebuilds `tasks` without `assignee`, which a
  later migration then reads (`no such column: assignee`).
- Marking the gaps as applied, as the old migrator effectively did, leaves the
  later migrations looking for tables the gaps create (`no such table:
  attachments`).

No replay order works. These bare tables are dead to the runtime: task reads
and writes use the prefixed `tasks_tasks` family, and only a few bare tables
such as `attachments` are still used. So when the `drizzle-tasks` migration
fails on a consolidated store, the open now rebuilds that family the way a new
project gets it:

1. It writes a full snapshot with `VACUUM INTO`
   (`.cleo/backups/cleo-pre-t12346-lineage-rebuild-<ts>.db`). The old bare rows
   are kept there unchanged, and the repair stops if the snapshot fails.
2. In one transaction, it drops only the objects this lineage creates (never an
   object that the consolidated, brain, nexus or any other lineage also
   creates) and removes only this lineage's journal rows.
3. In the same transaction, it runs the whole lineage from the start.

If anything fails, the transaction rolls back and the original error is
reported. The prefixed tables are never touched. On claude-todo the result has
exactly the same tables and triggers as a healthy project.

The rebuild also exposed a mapping gap. Legacy `release_manifests` had no
entry in the exodus table map, so its rows went into a stale bare table that
nothing reads. They now go into `tasks_releases`, converted the same way the
T9686-B2 migration converts them (`id = 'legacy:' || version`,
`merge_commit_sha = commit_sha`). The copy, the reconcile key check and the
parity digest all use that conversion.

The parity verifier's digest now fills a NULL in a NOT NULL column that has a
default the same way the copy does, including the `valid_at` → `created_at`
fallback. Brain tables no longer report a false hash mismatch after a correct
migration.
