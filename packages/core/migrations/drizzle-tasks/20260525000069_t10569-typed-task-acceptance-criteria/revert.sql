-- Revert T10569 typed completion-criteria columns.
--
-- SQLite cannot DROP COLUMN safely across supported runtimes while preserving
-- dependent FK/index metadata, so the down migration only removes the indexes.
-- The additive columns are left in place for forward-compatible rollback.

DROP INDEX IF EXISTS `idx_task_acceptance_criteria_target_task_id`;
--> statement-breakpoint
DROP INDEX IF EXISTS `uq_task_acceptance_criteria_task_source_key`;
