-- Revert T10504 — drop `task_acceptance_criteria_history` + its index.
--
-- Dropping the table implicitly drops its indices; we list the index
-- explicitly to keep the reversal idempotent and self-documenting.

DROP INDEX IF EXISTS `idx_ac_history_ac_id_recorded_at`;
--> statement-breakpoint
DROP TABLE IF EXISTS `task_acceptance_criteria_history`;
