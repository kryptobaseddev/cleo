---
id: on-open-runtime-targets-additive-reconcile
tasks: [T12355]
kind: fix
summary: "The automatic migration on first open now puts rows in the same tables as reconcile does (the ones the runtime reads); new `--reconcile --additive` mode for projects already running on cleo.db"
---

**The automatic migration on first open now uses the runtime's tables.** That
migration (exodus-on-open) runs when a project is opened. Until now it copied
legacy `audit_log`, `token_usage`, `architecture_decisions`, `attachments`,
`schema_meta` and similar tables into `tasks_*` tables that the runtime never
reads. It now uses the same `buildRuntimeTargetResolver` as `cleo doctor
superseded-store --reconcile`.

- Before copying, it creates the runtime's tasks-domain tables on the
  migration's own connection (`ensureTasksDomainTables`). Several target tables
  exist only after that step, and opening the whole tasks domain from inside a
  database open would wait on itself.
- Before the copy, it removes the default `task_id_sequence` value. A legacy
  counter then replaces it, and defaults are only filled in afterwards. Before
  this, a reconciled project kept the default `T000` counter even though its
  legacy store had a real one.
- The parity check (`verifyMigration`) looks for each row in the same table
  the copy wrote it to. Only the value conversions still use the consolidated
  names. A foreign-key reference counts as pre-existing when its parent is
  missing from every legacy table that feeds that parent table.

On copies of caamp, lafs-protocol, proxmox and signaldock, the first open with
`CLEO_DISABLE_EXODUS_ON_OPEN` unset migrated every row to the table the runtime
reads, as confirmed by `getLifecycleStatus` and `queryAudit`. The resulting
per-table row counts are identical to what reconcile produces for the same
project.

**Reconcile no longer copies default rows.** When reconcile reads rows from an
unmigrated `cleo.db`, it skips any row whose key already exists in a newly
created project store. It matches on the key because default rows carry the
time they were created. This includes the 18 backfilled `commits` rows. Before
this, reconcile copied them into `tasks_commits`, which the automatic migration
never did.

**`cleo doctor superseded-store --reconcile --additive`** is for a project that
already runs on `cleo.db` (for example kodomeet).

- It never writes the live task graph: the tables the runtime reads from
  `tasks_*` (`tasks`, `task_dependencies`, `task_acceptance_criteria`,
  `lifecycle_*`, and so on). A legacy row missing from them may have been
  deleted or rewritten since the switch.
- It copies only history rows (`audit_log`, `token_usage`,
  `pipeline_manifest`, brain rows, and so on) whose keys are absent from live.
- Every row it leaves behind is listed in the receipt's `conflicts`, marked
  `live-authoritative` or `collides-with-live`.

Both modes now also check that every live row that existed before the copy is
still present and unchanged afterwards. If not, they revert the run and refuse.

On a copy of kodomeet, the additive run copied 2,232 rows. `queryAudit` went
from 841 to 2,182 rows (the 1,341 legacy audit rows), and the 866
`token_usage` and 24 `pipeline_manifest` rows can now be read. It reported 83
acceptance criteria and 8 dependencies as conflicts. All 77,702 pre-existing
live rows were unchanged (every table except the sqlite-vec `brain_embeddings`
index, which can't be read without its extension and was not written), and a second run changes nothing.

**Reconcile and the automatic migration no longer interfere, and give the same
result in either order.** With `CLEO_DISABLE_EXODUS_ON_OPEN` unset (the default
after v2026.9.17), a database open during a reconcile used to start the
automatic migration. That migration archived `tasks.db`, which the reconcile was
about to read, so it failed with `E_CLI_UNCAUGHT` "unable to open database
…/.cleo/tasks.db". The v2026.9.17 Stage A gate caught this.

- The reconcile now runs inside `withExodusOnOpenSuppressed(store)`, a scope
  covering only that store and only that process. The automatic migration skips
  a store while the scope is active.
- If the automatic migration runs first, the reconcile then finds the legacy
  files already archived and reports `nothing-to-reconcile`. The row placement
  is identical either way.
- If the reconcile runs first, the automatic migration then skips the store,
  because it is already populated.
- The automatic migration now also reads rows from an unmigrated `cleo.db`'s
  old unprefixed task tables, the same extra source the reconcile reads.
  Without it, llmtxt's 1,972 `task_labels` rows (which exist only in those
  tables) were left behind.
- Result on copies of llmtxt and claude-todo with the switch unset: running the
  automatic migration first or the reconcile first gives identical row counts
  in every table. The reconcile exits 0 in both orders.
- The reconcile's check that existing live rows are unchanged now compares
  only the columns the old and new tables share. On claude-todo it had
  crashed with `E_CLI_UNCAUGHT` after the copy, because the rebuild adds
  columns. A failure of the check itself now reverts the run and refuses,
  instead of crashing.

The reconcile and lineage test suites now run every case with the kill switch
explicitly set and explicitly unset. A developer machine that exports the
variable can no longer hide what CI (where it is unset) does.
