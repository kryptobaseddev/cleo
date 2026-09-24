---
id: stranded-store-sweep-fixes
tasks: [T12346]
kind: fix
summary: "Stranded-store reconcile now works on every legacy layout found across 18 projects: old journal format, runtime FTS triggers, cleo.db-only rows, and newer bare copies; the lineage rebuild keeps rows the runtime still reads"
---

We ran the reconcile flow on copies of all 18 projects with legacy data. The
flow was: dry-run, reconcile, second reconcile, then `cleo list`. On the final
code, 17 projects reconcile completely, `cleo list` works on all of them, and
a second run changes nothing. Five kinds of failure were found and fixed.

**The lineage rebuild dropped tables the runtime still reads.** The T12346
rebuild treated every bare `drizzle-tasks` table as dead. Only the task-core
tables that `tasks-schema.ts` re-points at `tasks_*` are unused. The runtime
still reads and writes the bare `lifecycle_*`, `audit_log`, `token_usage`,
`attachments`, `releases` and similar tables. After the tables are recreated,
the rebuild now copies every snapshot row back in, in the same transaction.
In claude-todo that is 16,942 rows, including all 45 lifecycle pipelines and
252 stages. Rows the new schema rejects, such as the unused bare `tasks` rows,
stay only in the snapshot, and the log lists them.

**The old migration-journal format blocked every open** (clawmsgr, execdash,
screennest and a t3code worktree). Their `cleo.db` is a renamed store from
before the consolidation. Its `__drizzle_migrations` table uses the old
format (no `name` column, NULL ids) and holds 19–25 rows that no current
migration set recognises. Drizzle's own format upgrade checks the rows against
only the migration set currently running, and fails on the others. The new
`upgradeSharedJournalFormat` performs that upgrade against every migration set
that shares the journal. Rows none of them recognise keep a NULL name, which
the existing unknown-row handling already deals with.

**The runtime's FTS triggers were refused as unexpected side effects**
(proxmox, kodomeet). `brain_observations_ai` writes the table's full-text
index when a row is inserted. The recovery check in exodus now allows a trigger
to write the copied table's own `<table>_fts*` index. When recovery removes a
row, the matching delete trigger removes its index entry.

**Some rows existed only inside an unmigrated `cleo.db`.** They were in its
bare task-core tables and in no legacy file: llmtxt has 1,972 `task_labels`,
pump-sniper-cli 249, voyc 182, and versionguard, ferrous-forge and others
have `task_dependencies` rows. When `tasks_tasks` is still empty, reconcile now
also reads those bare tables, taken from a snapshot built table by table
(copying the whole file and pruning it fails on sqlite-vec `vec0` virtual
tables). Once a project has run on the new tables, they are no longer read,
so rows the runtime has since deleted are not brought back.

**The older copy of a task could win.** In forge-ts, 58 of the 65 tasks that
differ between the two copies were updated more recently in `cleo.db`'s bare
table. Rows whose `updated_at` is newer than the legacy copy now come from a
separate source that is copied first. In the sweep, no task ended up with an
older version than one of its sources.
