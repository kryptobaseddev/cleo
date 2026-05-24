-- Revert T10505 — remove backfill rows from `task_acceptance_criteria`
-- + `task_acceptance_criteria_history`.
--
-- Reverts the two INSERTs in the forward migration:
--   * Step 1: backfilled AC rows. We delete every AC row whose `id`
--     appears in a `task_acceptance_criteria_history` row with
--     `reason='backfill'` — i.e. the rows this migration created.
--     ACs created by post-backfill writers (which would have a
--     `reason='edit'` or no history at all) are PRESERVED.
--   * Step 2: backfill history rows. Drop them by `reason`.
--
-- Order: AC rows first, then history rows. The AC delete reads the
-- history table to identify backfill-origin rows, so it must run
-- before the history rows are removed.

DELETE FROM `task_acceptance_criteria`
WHERE `id` IN (
  SELECT `ac_id`
    FROM `task_acceptance_criteria_history`
   WHERE `reason` = 'backfill'
);
--> statement-breakpoint

DELETE FROM `task_acceptance_criteria_history`
WHERE `reason` = 'backfill';
