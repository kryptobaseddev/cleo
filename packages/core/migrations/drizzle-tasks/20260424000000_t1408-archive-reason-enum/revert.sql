-- T1408 — DOWN MIGRATION (manual rollback only).
--
-- This file is NOT consumed by drizzle-kit (drizzle does not run down-migs).
-- It is the documented inverse of migration.sql for emergency rollback.
--
-- Apply with:
--   sqlite3 .cleo/tasks.db < packages/core/migrations/drizzle-tasks/20260424000000_t1408-archive-reason-enum/revert.sql
--
-- Round-trip evidence: .cleo/agent-outputs/T1408-dryrun/down.log
--
-- Steps:
--   1. Drop the T877 triggers (will be recreated against the rebuilt table).
--   2. Drop every index on `tasks`.
--   3. Build `__old_tasks` with the same shape but archive_reason = TEXT
--      (no CHECK).
--   4. Copy rows.
--   5. Swap.
--   6. Recreate indexes + triggers.
--
-- @task T1408

PRAGMA foreign_keys = OFF;

DROP TRIGGER IF EXISTS `trg_tasks_status_pipeline_insert`;
DROP TRIGGER IF EXISTS `trg_tasks_status_pipeline_update`;

DROP INDEX IF EXISTS `idx_tasks_status`;
DROP INDEX IF EXISTS `idx_tasks_parent_id`;
DROP INDEX IF EXISTS `idx_tasks_phase`;
DROP INDEX IF EXISTS `idx_tasks_type`;
DROP INDEX IF EXISTS `idx_tasks_priority`;
DROP INDEX IF EXISTS `idx_tasks_session_id`;
DROP INDEX IF EXISTS `idx_tasks_pipeline_stage`;
DROP INDEX IF EXISTS `idx_tasks_assignee`;
DROP INDEX IF EXISTS `idx_tasks_parent_status`;
DROP INDEX IF EXISTS `idx_tasks_status_priority`;
DROP INDEX IF EXISTS `idx_tasks_type_phase`;
DROP INDEX IF EXISTS `idx_tasks_status_archive_reason`;
DROP INDEX IF EXISTS `idx_tasks_role`;
DROP INDEX IF EXISTS `idx_tasks_scope`;
DROP INDEX IF EXISTS `idx_tasks_role_status`;
DROP INDEX IF EXISTS `idx_tasks_sentient_proposals_today`;

CREATE TABLE `__old_tasks` (
  `id` text PRIMARY KEY,
  `title` text NOT NULL,
  `description` text,
  `status` text DEFAULT 'pending' NOT NULL,
  `priority` text DEFAULT 'medium' NOT NULL,
  `type` text,
  `parent_id` text,
  `phase` text,
  `size` text,
  `position` integer,
  `position_version` integer DEFAULT 0,
  `labels_json` text DEFAULT '[]',
  `notes_json` text DEFAULT '[]',
  `acceptance_json` text DEFAULT '[]',
  `files_json` text DEFAULT '[]',
  `origin` text,
  `blocked_by` text,
  `epic_lifecycle` text,
  `no_auto_complete` integer,
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  `updated_at` text,
  `completed_at` text,
  `cancelled_at` text,
  `cancellation_reason` text,
  `archived_at` text,
  `archive_reason` text,
  `cycle_time_days` integer,
  `verification_json` text,
  `created_by` text,
  `modified_by` text,
  `session_id` text,
  `pipeline_stage` text,
  `assignee` text,
  `ivtr_state` text,
  `role` TEXT NOT NULL DEFAULT 'work'
    CHECK (`role` IN ('work','research','experiment','bug','spike','release')),
  `scope` TEXT NOT NULL DEFAULT 'feature'
    CHECK (`scope` IN ('project','feature','unit')),
  `severity` TEXT
    CHECK (`severity` IS NULL OR (`severity` IN ('P0','P1','P2','P3') AND `role`='bug')),
  CONSTRAINT `fk_tasks_parent_id` FOREIGN KEY (`parent_id`) REFERENCES `__old_tasks`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_tasks_session_id` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE SET NULL
);

INSERT INTO `__old_tasks` (
  `id`, `title`, `description`, `status`, `priority`, `type`, `parent_id`,
  `phase`, `size`, `position`, `position_version`, `labels_json`, `notes_json`,
  `acceptance_json`, `files_json`, `origin`, `blocked_by`, `epic_lifecycle`,
  `no_auto_complete`, `created_at`, `updated_at`, `completed_at`, `cancelled_at`,
  `cancellation_reason`, `archived_at`, `archive_reason`, `cycle_time_days`,
  `verification_json`, `created_by`, `modified_by`, `session_id`, `pipeline_stage`,
  `assignee`, `ivtr_state`, `role`, `scope`, `severity`
)
SELECT
  `id`, `title`, `description`, `status`, `priority`, `type`, `parent_id`,
  `phase`, `size`, `position`, `position_version`, `labels_json`, `notes_json`,
  `acceptance_json`, `files_json`, `origin`, `blocked_by`, `epic_lifecycle`,
  `no_auto_complete`, `created_at`, `updated_at`, `completed_at`, `cancelled_at`,
  `cancellation_reason`, `archived_at`, `archive_reason`, `cycle_time_days`,
  `verification_json`, `created_by`, `modified_by`, `session_id`, `pipeline_stage`,
  `assignee`, `ivtr_state`, `role`, `scope`, `severity`
FROM `tasks`;

DROP TABLE `tasks`;
ALTER TABLE `__old_tasks` RENAME TO `tasks`;

CREATE INDEX `idx_tasks_status` ON `tasks` (`status`);
CREATE INDEX `idx_tasks_parent_id` ON `tasks` (`parent_id`);
CREATE INDEX `idx_tasks_phase` ON `tasks` (`phase`);
CREATE INDEX `idx_tasks_type` ON `tasks` (`type`);
CREATE INDEX `idx_tasks_priority` ON `tasks` (`priority`);
CREATE INDEX `idx_tasks_session_id` ON `tasks` (`session_id`);
CREATE INDEX `idx_tasks_pipeline_stage` ON `tasks` (`pipeline_stage`);
CREATE INDEX `idx_tasks_assignee` ON `tasks` (`assignee`);
CREATE INDEX `idx_tasks_parent_status` ON `tasks` (`parent_id`, `status`);
CREATE INDEX `idx_tasks_status_priority` ON `tasks` (`status`, `priority`);
CREATE INDEX `idx_tasks_type_phase` ON `tasks` (`type`, `phase`);
CREATE INDEX `idx_tasks_status_archive_reason` ON `tasks` (`status`, `archive_reason`);
CREATE INDEX `idx_tasks_role` ON `tasks` (`role`);
CREATE INDEX `idx_tasks_scope` ON `tasks` (`scope`);
CREATE INDEX `idx_tasks_role_status` ON `tasks` (`role`, `status`);
CREATE INDEX `idx_tasks_sentient_proposals_today`
  ON `tasks` (date(`created_at`))
  WHERE `labels_json` LIKE '%sentient-tier2%';

CREATE TRIGGER `trg_tasks_status_pipeline_insert`
BEFORE INSERT ON `tasks`
FOR EACH ROW
WHEN (NEW.`status` = 'done'      AND (NEW.`pipeline_stage` IS NULL OR NEW.`pipeline_stage` NOT IN ('contribution','cancelled')))
  OR (NEW.`status` = 'cancelled' AND (NEW.`pipeline_stage` IS NULL OR NEW.`pipeline_stage` != 'cancelled'))
BEGIN
  SELECT RAISE(ABORT, 'T877_INVARIANT_VIOLATION: status/pipeline_stage mismatch. status=done requires pipeline_stage IN (contribution,cancelled); status=cancelled requires pipeline_stage=cancelled.');
END;

CREATE TRIGGER `trg_tasks_status_pipeline_update`
BEFORE UPDATE OF `status`, `pipeline_stage` ON `tasks`
FOR EACH ROW
WHEN (NEW.`status` = 'done'      AND (NEW.`pipeline_stage` IS NULL OR NEW.`pipeline_stage` NOT IN ('contribution','cancelled')))
  OR (NEW.`status` = 'cancelled' AND (NEW.`pipeline_stage` IS NULL OR NEW.`pipeline_stage` != 'cancelled'))
BEGIN
  SELECT RAISE(ABORT, 'T877_INVARIANT_VIOLATION: status/pipeline_stage mismatch. status=done requires pipeline_stage IN (contribution,cancelled); status=cancelled requires pipeline_stage=cancelled.');
END;

PRAGMA foreign_keys = ON;
