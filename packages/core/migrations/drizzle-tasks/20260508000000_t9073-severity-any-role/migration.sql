-- T9073 — Widen `tasks.severity` CHECK constraint to allow any role.
--
-- Background:
--   T944 added `severity` with a composite CHECK:
--     severity IS NULL OR (severity IN ('P0','P1','P2','P3') AND role='bug')
--   This coupled severity to role='bug', preventing other roles (spike, work,
--   research, etc.) from carrying a severity level.
--
--   Owner directive (T9073 / T9067 epic): severity is a system-wide axis,
--   orthogonal to role. Any task type — bug, spike, incident, feature — should
--   be able to carry a P0–P3 severity label with an attestation trail.
--
-- Change:
--   Old CHECK: severity IS NULL OR (severity IN ('P0','P1','P2','P3') AND role='bug')
--   New CHECK: severity IS NULL OR severity IN ('P0','P1','P2','P3')
--
--   Priority is NOT auto-mapped from severity. The SEVERITY_MAP that existed
--   in `cleo bug` was intentionally not replicated into `cleo add` / `cleo update`.
--   Severity and priority are now fully orthogonal axes.
--
-- SQLite cannot ALTER a CHECK constraint, so this migration follows the
-- canonical "table rebuild" recipe (same pattern as T1408):
--
--   1. Drop triggers + indexes on `tasks`.
--   2. Create `__new_tasks` with the widened CHECK.
--   3. INSERT … SELECT all rows (no data transformation needed — existing
--      severity values only appear on role='bug' rows so they remain valid
--      under the wider constraint too).
--   4. DROP `tasks`; RENAME `__new_tasks` TO `tasks`.
--   5. Recreate indexes + T877 triggers.
--
-- @task T9073
-- @epic T9067

PRAGMA foreign_keys = OFF;
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Step 1 — Drop triggers and indexes attached to `tasks`.
-- --------------------------------------------------------------------------
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

-- --------------------------------------------------------------------------
-- Step 2 — Create `__new_tasks` with the widened severity CHECK.
--          All other columns / constraints / defaults are preserved verbatim.
-- --------------------------------------------------------------------------
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

-- --------------------------------------------------------------------------
-- Step 3 — Copy every row; no data transformation needed.
--          Existing severity values only appear on role='bug' rows, so they
--          are valid under the wider constraint too.
-- --------------------------------------------------------------------------
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

-- --------------------------------------------------------------------------
-- Step 4 — Swap tables.
-- --------------------------------------------------------------------------
DROP TABLE `tasks`;
--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Step 5 — Recreate indexes.
-- --------------------------------------------------------------------------
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

-- --------------------------------------------------------------------------
-- Step 6 — Recreate T877 status/pipeline_stage invariant triggers.
-- --------------------------------------------------------------------------
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
