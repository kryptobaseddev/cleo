-- T11962 (under T11679) — the cron/todo schedule sink (`schedules`).
--
-- One row per recurring schedule registered by the `cron_schedule` agent tool
-- (T11950): a cron expression + the task template (title / description)
-- materialized on each fire, an `enabled` flag, and create/update timestamps. The
-- tool registers a row daemon-OFF via the leased Gate-3 accessor
-- (schedule-store.ts); a future daemon scheduler consumes the SAME table as a
-- separate reader (AC4).
--
-- Co-located inside EACH scope's consolidated cleo.db (this file is byte-identical
-- in drizzle-cleo-project and drizzle-cleo-global so the two lineages produce the
-- SAME migration hash — the consolidated single-file journal converges across both
-- under the CONSOLIDATED_JOURNAL_LINEAGES cross-lineage guard, T11829). Pure
-- runtime infrastructure (like `_writer_leases` from T11627, `pi_session_*` from
-- T11899, and `selfimprove_dhq` from T11911) — NOT part of the exodus target shape
-- under `schema/cleo-project/`, so the consolidated schema-parity gate (T11364)
-- does not re-derive its CHECK set.
--
-- ## Page-2 invariant
--
-- This migration runs AFTER the consolidation baseline (…_t11363-consolidation-
-- cleo-project) which already creates dozens of tables, so `schedules` is NEVER
-- the first CREATE on a fresh DB — rootpage 2 is already owned by
-- `__drizzle_migrations` / the baseline tables.
--
-- `IF NOT EXISTS` so a re-open over an already-migrated DB is a no-op. Each
-- statement is separated by a drizzle breakpoint marker line so node:sqlite
-- prepare() does not silently truncate the multi-statement file to statement one
-- (the marker token is intentionally not spelled out in this comment — drizzle's
-- readMigrationFiles splits the file on that literal substring).
--
-- @task T11962
-- @epic T11679

CREATE TABLE IF NOT EXISTS `schedules` (
  `id` INTEGER PRIMARY KEY,
  `schedule_id` TEXT NOT NULL,
  `cron_expr` TEXT NOT NULL,
  `title` TEXT NOT NULL,
  `description` TEXT,
  `enabled` INTEGER NOT NULL DEFAULT 1 CHECK (`enabled` IN (0, 1)),
  `created_at` TEXT NOT NULL DEFAULT (datetime('now')),
  `updated_at` TEXT NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `ux_schedules_schedule_id` ON `schedules` (`schedule_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ix_schedules_enabled` ON `schedules` (`enabled`);
