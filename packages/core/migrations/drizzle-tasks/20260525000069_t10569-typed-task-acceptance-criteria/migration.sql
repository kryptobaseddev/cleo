-- T10569 — Add PM-Core V2 typed completion-criteria columns to task_acceptance_criteria.
--
-- ADR-088 defines completion criteria as typed rows:
--   kind ∈ {text, child_task, evidence_bound}
--   child_task criteria carry target_task_id
--   source_key gives each producer a stable idempotency key per parent task
--   projection records the compatibility/projection surface that created the row
--
-- This migration is intentionally additive. Existing AC rows are legacy text
-- criteria, so they receive kind='text', projection='legacy', and a deterministic
-- source_key derived from their existing monotonic ordinal + current content.
--
-- @adr ADR-088
-- @saga T10538
-- @task T10569

ALTER TABLE `task_acceptance_criteria`
  ADD COLUMN `kind` TEXT NOT NULL DEFAULT 'text';
--> statement-breakpoint

ALTER TABLE `task_acceptance_criteria`
  ADD COLUMN `source_key` TEXT;
--> statement-breakpoint

ALTER TABLE `task_acceptance_criteria`
  ADD COLUMN `target_task_id` TEXT REFERENCES `tasks`(`id`) ON DELETE SET NULL;
--> statement-breakpoint

ALTER TABLE `task_acceptance_criteria`
  ADD COLUMN `projection` TEXT NOT NULL DEFAULT 'legacy';
--> statement-breakpoint

UPDATE `task_acceptance_criteria`
SET `source_key` = 'text:' || `ordinal` || ':' || substr(coalesce(`content_hash`, lower(hex(`text`))), 1, 12)
WHERE `source_key` IS NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS `uq_task_acceptance_criteria_task_source_key`
  ON `task_acceptance_criteria` (`task_id`, `source_key`);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_task_acceptance_criteria_target_task_id`
  ON `task_acceptance_criteria` (`target_task_id`);
