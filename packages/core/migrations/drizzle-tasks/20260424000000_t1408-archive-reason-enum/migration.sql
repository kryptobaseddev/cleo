-- T1408 — Migrate `tasks.archive_reason` from unconstrained TEXT to a
--         6-value CHECK-constrained TEXT column.
--
-- Council 2026-04-24 mandate (FINDING #28 follow-through). The 6 canonical
-- archive reasons are:
--
--   verified
--   reconciled
--   superseded
--   shadowed
--   cancelled
--   completed-unverified
--
-- SQLite cannot ADD a CHECK constraint to an existing column, so this
-- migration follows the canonical SQLite "table rebuild" recipe. Steps:
--
--   1. Normalize existing non-conforming values to 'completed-unverified'
--      so the CHECK does not reject any pre-existing row.
--   2. Drop indexes + triggers attached to `tasks` (they will be recreated
--      against the new table).
--   3. Create `__new_tasks` with the same schema, but `archive_reason`
--      carries `CHECK(archive_reason IS NULL OR archive_reason IN (…6…))`.
--   4. Copy every row from `tasks` to `__new_tasks`.
--   5. DROP `tasks`; ALTER `__new_tasks` RENAME TO `tasks`.
--   6. Recreate the original indexes (including the partial T1126 index)
--      and the T877 invariant triggers.
--
-- Pre-migration row distribution observed on .cleo/tasks.db (2026-04-24):
--   NULL                : 350
--   cancelled           :  59
--   completed           : 995  ← normalized to 'completed-unverified'
--   deleted             :  42  ← normalized to 'completed-unverified'
--
-- Down-migration (revert.sql in this folder) recreates the table without
-- the CHECK constraint. Round-trip evidence under
-- .cleo/agent-outputs/T1408-dryrun/.
--
-- @task T1408
-- @epic T1407 (parent — Council 2026-04-24 archive truth-grade workstream)

PRAGMA foreign_keys = OFF;
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Step 1 — Normalize non-conforming archive_reason values BEFORE the rebuild.
-- --------------------------------------------------------------------------
UPDATE `tasks`
   SET `archive_reason` = 'completed-unverified',
       `updated_at`     = datetime('now')
 WHERE `archive_reason` IS NOT NULL
   AND `archive_reason` NOT IN (
         'verified',
         'reconciled',
         'superseded',
         'shadowed',
         'cancelled',
         'completed-unverified'
       );
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Step 2 — Drop triggers + indexes that hang off `tasks`.
--          Triggers must be dropped because they reference `tasks` by name
--          and will not survive the rename. Indexes will be dropped by
--          DROP TABLE anyway, but we drop them explicitly for clarity.
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
-- Step 3 — Create `__new_tasks` with the CHECK-constrained archive_reason.
--          All other columns / constraints / defaults are preserved verbatim
--          from the canonical schema (see packages/core/src/store/tasks-schema.ts
--          and the T944 role/scope/severity DDL emitted into the live table).
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
    CHECK (`severity` IS NULL OR (`severity` IN ('P0','P1','P2','P3') AND `role`='bug')),
  CONSTRAINT `fk_tasks_parent_id` FOREIGN KEY (`parent_id`) REFERENCES `__new_tasks`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_tasks_session_id` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Step 4 — Copy every row, column-for-column.
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
-- Step 5 — Swap tables. The self-FK in `__new_tasks` references its own name,
--          so we rename via a two-step dance: drop old, rename new. SQLite
--          rewrites internal FK references on RENAME so `parent_id` ends up
--          pointing at the renamed `tasks` table.
-- --------------------------------------------------------------------------
DROP TABLE `tasks`;
--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Step 6 — Recreate indexes (matches the live shape post-T944 + post-T1126).
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
-- Step 7 — Recreate T877 status/pipeline_stage invariant triggers.
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
