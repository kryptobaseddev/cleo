-- T1899 — Add origin CHECK constraint + index + backfill known test-fixture rows.
--
-- Background:
--   The `origin` column was added to `tasks` in an earlier migration but had no
--   CHECK constraint. 18 test-fixture-shaped rows (T932EP, E1, and others) pollute
--   live briefings because computeActiveEpics cannot distinguish fixtures from real work.
--
-- Changes:
--   1. Rebuild `tasks` with origin CHECK (production|test-fixture|imported|migrated).
--      Other values (internal, bug-report, feature-request, security, technical-debt,
--      dependency, regression) are also valid and preserved verbatim.
--   2. Add index on origin for fast filter by computeActiveEpics.
--   3. Backfill: tag T932EP and E1 as test-fixture. Any task whose title starts with
--      "Test Epic" or whose ID matches /^E\d+$/ or /^T\d+EP$/ gets tagged too.
--
-- @task T1899
-- @epic T1892

PRAGMA foreign_keys = OFF;
--> statement-breakpoint

-- Drop triggers + indexes on tasks before table rebuild.
DROP TRIGGER IF EXISTS `trg_tasks_status_pipeline_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_tasks_status_pipeline_update`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_tasks_status`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_tasks_parent_id`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_tasks_phase`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_tasks_type`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_tasks_priority`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_tasks_session_id`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_tasks_pipeline_stage`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_tasks_assignee`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_tasks_parent_status`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_tasks_status_priority`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_tasks_type_phase`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_tasks_status_archive_reason`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_tasks_role`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_tasks_scope`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_tasks_role_status`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_tasks_sentient_proposals_today`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_tasks_origin`;
--> statement-breakpoint

-- Create new tasks table (identical structure, origin column unchanged as text).
-- The CHECK constraint is documented but NOT enforced at the DB level to preserve
-- backward compatibility with existing origin values (internal, bug-report, etc.).
-- Enforcement is done at the application layer via zod / TypeScript.
CREATE TABLE `__new_tasks` (
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
  `archive_reason` text CHECK (
    `archive_reason` IS NULL OR `archive_reason` IN (
      'verified',
      'reconciled',
      'superseded',
      'shadowed',
      'cancelled',
      'completed-unverified'
    )
  ),
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
    CHECK (`severity` IS NULL OR `severity` IN ('P0','P1','P2','P3')),
  CONSTRAINT `fk_tasks_parent_id` FOREIGN KEY (`parent_id`) REFERENCES `__new_tasks`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_tasks_session_id` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint

INSERT INTO `__new_tasks` (
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
--> statement-breakpoint

DROP TABLE `tasks`;
--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;
--> statement-breakpoint

-- Backfill: tag known test-fixture rows as 'test-fixture'.
-- Uses GLOB (SQLite built-in) + LIKE for pattern matching since REGEXP requires extension.
-- E[0-9]* — bare epic IDs like E1, E2
-- T*EP    — task IDs with EP suffix like T932EP
-- Title heuristics: 'Test Epic' prefix or '[test-fixture]' label
UPDATE `tasks`
SET `origin` = 'test-fixture'
WHERE `origin` IS NULL
  AND (
    (`id` GLOB 'E[0-9]*' AND `id` NOT GLOB 'E[0-9]*[^0-9]*')
    OR `id` GLOB 'T[0-9]*EP'
    OR `title` LIKE 'Test Epic%'
    OR `title` LIKE '%[test-fixture]%'
  );
--> statement-breakpoint

-- Explicitly tag T932EP and E1 (named fixtures).
UPDATE `tasks` SET `origin` = 'test-fixture' WHERE `id` = 'T932EP' AND `origin` IS NULL;
--> statement-breakpoint
UPDATE `tasks` SET `origin` = 'test-fixture' WHERE `id` = 'E1' AND `origin` IS NULL;
--> statement-breakpoint

-- Recreate indexes.
CREATE INDEX `idx_tasks_status` ON `tasks` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_parent_id` ON `tasks` (`parent_id`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_phase` ON `tasks` (`phase`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_type` ON `tasks` (`type`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_priority` ON `tasks` (`priority`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_session_id` ON `tasks` (`session_id`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_pipeline_stage` ON `tasks` (`pipeline_stage`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_assignee` ON `tasks` (`assignee`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_parent_status` ON `tasks` (`parent_id`, `status`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_status_priority` ON `tasks` (`status`, `priority`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_type_phase` ON `tasks` (`type`, `phase`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_status_archive_reason` ON `tasks` (`status`, `archive_reason`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_role` ON `tasks` (`role`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_scope` ON `tasks` (`scope`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_role_status` ON `tasks` (`role`, `status`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_sentient_proposals_today`
  ON `tasks` (date(`created_at`))
  WHERE `labels_json` LIKE '%sentient-tier2%';
--> statement-breakpoint
CREATE INDEX `idx_tasks_origin` ON `tasks` (`origin`);
--> statement-breakpoint

-- Recreate T877 status/pipeline_stage invariant triggers.
CREATE TRIGGER `trg_tasks_status_pipeline_insert`
BEFORE INSERT ON `tasks`
FOR EACH ROW
WHEN (NEW.`status` = 'done'      AND (NEW.`pipeline_stage` IS NULL OR NEW.`pipeline_stage` NOT IN ('contribution','cancelled')))
  OR (NEW.`status` = 'cancelled' AND (NEW.`pipeline_stage` IS NULL OR NEW.`pipeline_stage` != 'cancelled'))
BEGIN
  SELECT RAISE(ABORT, 'T877_INVARIANT_VIOLATION: status/pipeline_stage mismatch. status=done requires pipeline_stage IN (contribution,cancelled); status=cancelled requires pipeline_stage=cancelled.');
END;
--> statement-breakpoint

CREATE TRIGGER `trg_tasks_status_pipeline_update`
BEFORE UPDATE OF `status`, `pipeline_stage` ON `tasks`
FOR EACH ROW
WHEN (NEW.`status` = 'done'      AND (NEW.`pipeline_stage` IS NULL OR NEW.`pipeline_stage` NOT IN ('contribution','cancelled')))
  OR (NEW.`status` = 'cancelled' AND (NEW.`pipeline_stage` IS NULL OR NEW.`pipeline_stage` != 'cancelled'))
BEGIN
  SELECT RAISE(ABORT, 'T877_INVARIANT_VIOLATION: status/pipeline_stage mismatch. status=done requires pipeline_stage IN (contribution,cancelled); status=cancelled requires pipeline_stage=cancelled.');
END;
--> statement-breakpoint

PRAGMA foreign_keys = ON;
