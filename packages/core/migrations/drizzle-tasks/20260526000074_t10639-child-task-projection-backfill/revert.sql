-- Revert T10639 — remove backfill child_task AC projection rows.
--
-- Deletes AC rows whose history entry carries reason='backfill'
-- (matching the T10505 revert contract). Rows created by normal
-- addTask/reparet operations have history reason='edit' or
-- 'projection_rebuild' and are PRESERVED.
--
-- Order: AC rows first (reading history table), then history rows.

DELETE FROM `task_acceptance_criteria`
WHERE `id` IN (
  SELECT `ac_id`
    FROM `task_acceptance_criteria_history`
   WHERE `reason` = 'backfill'
);
--> statement-breakpoint

DELETE FROM `task_acceptance_criteria_history`
WHERE `reason` = 'backfill';
