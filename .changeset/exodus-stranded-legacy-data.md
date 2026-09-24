---
id: exodus-stranded-legacy-data
tasks: [T12319]
kind: fix
summary: "`cleo doctor superseded-store --reconcile` copies stranded legacy tasks.db/brain.db rows into cleo.db; exodus no longer aborts on real legacy data, and no longer skips it silently"
---

About 21 projects were running on an empty consolidated `.cleo/cleo.db` while
their legacy `tasks.db` and `brain.db` still held everything. llmtxt had 849
tasks and 1,696 observations; claude-todo had 5,330 tasks and 5,148
observations. `cleo list` returned 0. `cleo doctor superseded-store` saw the
rows but could only say "reconcile the contents first", and no command did
that. Two separate mechanisms caused this.

**1. The skip gave no warning.** `CLEO_DISABLE_EXODUS_ON_OPEN=1` was exported
machine-wide as a stopgap during the 2026-06-04 incident. `runExodusOnOpen`
returned `skipped` on it before any other check and printed nothing. The
kill-switch still works, but when an empty store sits beside legacy rows the
skip now prints a `STRANDED LEGACY DATA` warning on stderr that names the
remedy. A completion marker also can no longer hide an empty store while the
legacy files still hold rows. That case is now an abort (writes refuse) instead
of a skip, and it still never re-runs the migration.

**2. With the switch off, the copy engine aborted on real legacy data.** Each
of these was reproduced on copies of real stores:

- Tables were copied in alphabetical order, so `task_acceptance_criteria` ran
  before `tasks`. Foreign keys are deferred during the copy, but triggers are
  not, so `E_CHILD_TASK_TARGET_CONTAINMENT` rejected all 493 valid `child_task`
  criteria. Tables are now copied parents-first, following the source schema's
  foreign keys.
- Legacy `archive_reason` values outside the enum (`deleted`, `completed`,
  `recovered`, …) were dropped silently by `INSERT OR IGNORE`. They now follow
  the T1408 backfill rule and become `completed-unverified`.
- `done`/`cancelled` tasks with no terminal `pipeline_stage` failed the T877
  trigger and aborted the copy. They now follow the T877 backfill rule.
- The T10572 hierarchy guards were added without a backfill, so the legacy
  runtime kept existing task→task edges and edges that duplicate a parent. The
  guards are now paused for the historical copy only and restored in the same
  transaction. The cycle guard stays active.
- An explicit NULL in a `NOT NULL DEFAULT …` column made `INSERT OR IGNORE`
  drop the whole row: 1,284 of llmtxt's 1,696 observations had
  `valid_at IS NULL`. The copy now uses the column default instead, and
  `valid_at` falls back to the row's own `created_at`.
- The verifier counted a dangling reference as "introduced by migration" when
  the legacy schema never declared the foreign key. It now checks whether the
  missing parent key exists in any source. If it does not, the reference was
  already dangling before the migration.

**The new command.** `cleo doctor superseded-store --reconcile [--dry-run]`
copies rows through the same exodus engine, limited to the project store:

- It adds rows only (`INSERT OR IGNORE`) and never overwrites a row already
  in `cleo.db`.
- It checks every table by primary key, not by row count.
- If any key is still missing afterwards, it reverts exactly the rows this run
  inserted and exits non-zero (`E_RECONCILE_REFUSED`).
- It never moves or deletes the legacy files.
- It writes a receipt with before and after counts for each table.
- Running it a second time does nothing.

The survey now reports `missingInLive` for each file and points to the
command. After a reconcile it reports the file as "reconciled. Safe to
archive."
