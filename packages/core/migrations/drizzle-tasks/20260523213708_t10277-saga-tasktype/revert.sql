-- Revert T10277/T10329 — Demote 'saga' TaskType back to a label on Epics.
--
-- Steps (inverse of migration.sql, run in reverse order):
--   1. Rebuild `tasks` WITHOUT the new CHECK constraints on `type` and
--      WITHOUT the I5 (saga implies parent_id IS NULL) constraint.
--   2. Re-add 'saga' to `labels_json` for every row currently typed 'saga'.
--      The label is PREPENDED to the array — this restores byte-identical
--      JSON when the forward migration's input had 'saga' at index 0 (the
--      conventional / test-fixture encoding).
--   3. Flip `type = 'saga'` rows back to `type = 'epic'`.
--   4. Recreate the same indexes + triggers the migration drops.
--
-- Round-trip byte-identity caveat
-- ───────────────────────────────
-- The forward migration's Step 4 used `json_each(...) WHERE value != 'saga'`
-- which preserves the relative order of the OTHER labels. Round-tripping
-- back via PREPEND restores byte-identical `labels_json` IFF the original
-- labels array had 'saga' at index 0. The accompanying integration test
-- (`packages/core/src/store/__tests__/t10277-saga-tasktype.test.ts`)
-- enforces this invariant by seeding fixtures with 'saga' first.
--
-- Idempotency: this revert is NOT idempotent — re-running it would re-add
-- a second 'saga' element. The convention in this codebase is that revert
-- scripts run exactly once during a manual rollback; downgrade tooling is
-- responsible for tracking application state.
--
-- @task T10329
-- @epic T10277
-- @see migration.sql

PRAGMA foreign_keys = OFF;
--> statement-breakpoint

-- ── Step 0: Drop triggers + indexes (table rebuild prerequisite) ────────
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

-- ── Step 1: Re-prepend 'saga' label to currently-typed-saga rows ───────
-- Must run BEFORE we flip type='saga' → type='epic' so the WHERE predicate
-- can identify the right rows.
--
-- SQLite's JSON1 has no array-splice primitive: `json_insert($[0], ...)`
-- is a no-op when index 0 is already populated. We instead build the new
-- array textually: open with '["saga"', then concatenate either ']' (if
-- the source was an empty array) or ',<rest-of-array-body>' (if it had
-- elements). The `labels_json` schema always stores a JSON array, so
-- SUBSTR(labels_json, 2) extracts everything past the leading '['.
UPDATE `tasks`
SET `labels_json` = (
  CASE
    WHEN `labels_json` IS NULL OR NOT json_valid(`labels_json`)
      THEN '["saga"]'
    WHEN json_type(`labels_json`) != 'array'
      THEN '["saga"]'
    WHEN `labels_json` = '[]'
      THEN '["saga"]'
    ELSE '["saga",' || SUBSTR(`labels_json`, 2)
  END
)
WHERE `type` = 'saga';
--> statement-breakpoint

-- ── Step 2: Flip type='saga' back to type='epic' ───────────────────────
UPDATE `tasks` SET `type` = 'epic' WHERE `type` = 'saga';
--> statement-breakpoint

-- ── Step 3: Rebuild `tasks` WITHOUT the type/I5 CHECK constraints ──────
-- Schema matches the post-T1899 shape (the pre-T10329 state).
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

-- ── Step 4: Recreate indexes + triggers ────────────────────────────────
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
