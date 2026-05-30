-- T11356 — Denormalize tasks.labels_json into a task_labels junction.
--
-- Background:
--   Tier-2 sentient code filtered proposals with `labels_json LIKE
--   '%sentient-tier2%'` (sentient/ops.ts, sqlite-data-accessor.ts) and pinned a
--   partial index on the same fragile predicate. Substring matching on
--   serialized JSON matches ACROSS array boundaries (e.g. 'tier2' matches
--   'sentient-tier2-stale') and cannot use an index. This junction makes label
--   membership exact and index-backed.
--
--   labels_json is RETAINED as the legacy whole-array compatibility column; the
--   junction is the membership-query SSoT, kept in sync on every task write.
--
-- Changes (idempotent — safe to re-run):
--   1. CREATE TABLE task_labels(task_id, label) with composite PK + cascade FK.
--   2. CREATE INDEX idx_task_labels_label for the WHERE label = ? filter path.
--   3. Backfill from existing labels_json arrays via json_each. INSERT OR IGNORE
--      coalesces re-runs against the composite primary key.
--   4. Replace the fragile partial index idx_tasks_sentient_proposals_today
--      (LIKE-on-serialized-JSON predicate) with a plain date(created_at)
--      expression index that still accelerates the daily proposal-count scan.
--
-- @task T11356
-- @epic T11286
-- @saga T11283

CREATE TABLE IF NOT EXISTS `task_labels` (
  `task_id` text NOT NULL,
  `label` text NOT NULL,
  CONSTRAINT `task_labels_pk` PRIMARY KEY(`task_id`, `label`),
  CONSTRAINT `fk_task_labels_task_id_tasks_id_fk`
    FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_task_labels_label` ON `task_labels` (`label`);
--> statement-breakpoint

-- Backfill: explode each task's labels_json array into junction rows. json_each
-- yields zero rows for NULL/empty/non-array labels_json, so unlabeled tasks are
-- skipped cleanly. INSERT OR IGNORE makes the backfill idempotent on re-run.
INSERT OR IGNORE INTO `task_labels` (`task_id`, `label`)
SELECT t.`id`, je.`value`
FROM `tasks` AS t,
     json_each(t.`labels_json`) AS je
WHERE t.`labels_json` IS NOT NULL
  AND json_valid(t.`labels_json`)
  AND json_type(t.`labels_json`) = 'array'
  AND je.`value` IS NOT NULL;
--> statement-breakpoint

DROP INDEX IF EXISTS `idx_tasks_sentient_proposals_today`;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_tasks_created_date` ON `tasks` (date(`created_at`));
