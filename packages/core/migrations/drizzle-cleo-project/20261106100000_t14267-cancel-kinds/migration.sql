-- T14267 (owner decision D11229) — a cancel records its kind and replacement.
--
-- Additive only. Two NULL-able columns on `tasks_tasks`:
--   cancellation_kind  abandoned | superseded | duplicate | obsolete
--   replaced_by        the task that replaced a superseded or duplicate one
-- A child cancelled as superseded or duplicate whose replacement is done
-- counts as covered in a parent rollup with no waiver; abandoned and obsolete
-- still need `--waive-cancelled-children`. No existing row changes: both
-- columns are NULL after the migration, so every cancelled child still needs
-- the waiver until it is re-cancelled with a kind.
-- `replaced_by` is plain TEXT with no FK (a re-mint rewrites it as a declared
-- ROW_IDENTITY ref, like parent_id); both columns sync with the row, and the
-- migration runner regenerates the capture triggers for them.
--
-- @task T14267

ALTER TABLE `tasks_tasks` ADD COLUMN `cancellation_kind` TEXT CHECK ("cancellation_kind" IN ('abandoned', 'superseded', 'duplicate', 'obsolete'));
--> statement-breakpoint
ALTER TABLE `tasks_tasks` ADD COLUMN `replaced_by` TEXT;
