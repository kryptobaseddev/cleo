-- T10277 / T10329 — Promote 'saga' from a soft label on epics to a first-class TaskType.
--
-- Background
-- ──────────
-- ADR-073 §1 and ADR-076 originally encoded "Saga" as a label on a top-level
-- Epic row (`type='epic' AND labels_json LIKE '%saga%' AND parent_id IS NULL`).
-- ADR-083 §2.5 (LOCKED 2026-05-23) reverses that decision: Saga becomes its
-- own `TaskType` value, orthogonal to Epic/Task/Subtask, so the 4-scope axis
-- (Saga → Epic → Task → Subtask) is uniformly storable in the discriminator
-- column rather than via a side-channel label.
--
-- This migration:
--   1. Adds a CHECK constraint on `tasks.type` that enumerates the four
--      canonical TaskType values: 'saga', 'epic', 'task', 'subtask' (NULL
--      remains permitted for legacy rows that have no type assigned).
--   2. Adds a CHECK constraint enforcing ADR-073 §1.2 I5: any row with
--      `type = 'saga'` MUST have `parent_id IS NULL` (Sagas are roots).
--   3. Re-labels existing label-encoded saga rows: every row matching
--      `type='epic' AND parent_id IS NULL AND 'saga' IN labels_json` is
--      flipped to `type='saga'` AND the 'saga' label is stripped from
--      `labels_json` (so the label is not double-counted with the type).
--
-- SQLite limitations
-- ──────────────────
-- SQLite has no native enum and cannot ALTER COLUMN to add a CHECK; the
-- standard recipe is to rebuild the table. We follow the exact pattern
-- established by `20260512000000_t1899-origin-check-backfill` (T1899): drop
-- triggers + indexes, create `__new_tasks` with the additional CHECK, copy
-- rows in, drop+rename, restore triggers + indexes.
--
-- Idempotency
-- ───────────
-- Step (3)'s UPDATE is guarded by `WHERE type = 'epic' AND parent_id IS NULL
-- AND <label list contains 'saga'>`. After the migration runs once, matching
-- rows now have `type = 'saga'` and the 'saga' label removed, so the WHERE
-- clause yields zero rows on replay — the UPDATE is a no-op. Step (1) and
-- (2) only run inside the table rebuild, which Drizzle's journal guarantees
-- runs exactly once via its migration hash.
--
-- Round-trip
-- ──────────
-- `revert.sql` reverses every change: rebuilds `tasks` WITHOUT the type +
-- I5 CHECKs, flips `type='saga'` rows back to `type='epic'`, and prepends
-- 'saga' to `labels_json` (which restores byte-identical labels because the
-- forward migration appends; the revert prepends to mirror, see test
-- fixture). The round-trip is verified by
-- `packages/core/src/store/__tests__/t10277-saga-tasktype.test.ts`.
--
-- ADR-073 §1.2 I5: "Sagas have no parent — `parent_id IS NULL` is invariant
-- at storage layer for `type='saga'` rows."
--
-- @task T10329
-- @epic T10277
-- @saga T10326
-- @see .cleo/adrs/ADR-083-saga-as-tasktype.md §2.5
-- @see .cleo/adrs/ADR-073-above-epic-naming.md §1.2 I5
-- @see packages/core/migrations/drizzle-tasks/20260512000000_t1899-origin-check-backfill/migration.sql

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

-- ── Step 1: Create `__new_tasks` with type + I5 CHECKs ─────────────────
-- Schema mirrors the post-T1899 shape (the most recent table rebuild) plus
-- two new CHECK constraints on the `type` column:
--   (a) ENUM CHECK — type IS NULL OR type IN ('saga','epic','task','subtask')
--   (b) I5 CHECK   — type != 'saga' OR parent_id IS NULL  (Sagas are roots)
CREATE TABLE `__new_tasks` (
  `id` text PRIMARY KEY,
  `title` text NOT NULL,
  `description` text,
  `status` text DEFAULT 'pending' NOT NULL,
  `priority` text DEFAULT 'medium' NOT NULL,
  `type` text CHECK (
    `type` IS NULL OR `type` IN ('saga','epic','task','subtask')
  ),
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
  -- T10329: ADR-073 §1.2 I5 — Sagas have no parent.
  CONSTRAINT `chk_tasks_saga_no_parent` CHECK (
    `type` != 'saga' OR `parent_id` IS NULL
  ),
  CONSTRAINT `fk_tasks_parent_id` FOREIGN KEY (`parent_id`) REFERENCES `__new_tasks`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_tasks_session_id` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint

-- ── Step 2: Copy rows verbatim into the new table ──────────────────────
-- Pre-existing label-encoded saga rows still carry `type='epic'` at this
-- point; they will be flipped to `type='saga'` in Step 4 below (post-copy).
-- Copying with `type='epic'` first satisfies the new ENUM CHECK because
-- 'epic' is in the allowed set.
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

-- ── Step 3: Flip type='epic' → 'saga' for label-encoded sagas ──────────
-- Identification rule (ADR-076-era encoding):
--   type='epic' AND parent_id IS NULL AND labels_json contains 'saga'.
--
-- Ordering matters: flip TYPE first, then strip the 'saga' label. If we
-- stripped the label first, the WHERE clause below could no longer detect
-- which rows were originally label-encoded sagas.
--
-- The new I5 CHECK (`type != 'saga' OR parent_id IS NULL`) is satisfied
-- because we only touch rows where `parent_id IS NULL`.
--
-- Idempotency: on replay, every formerly-label-encoded row now has
-- type='saga' (so the `type = 'epic'` predicate is empty) AND no 'saga'
-- label in labels_json (so the EXISTS predicate is empty too). Both
-- UPDATEs become no-ops.
UPDATE `tasks`
SET `type` = 'saga'
WHERE `type` = 'epic'
  AND `parent_id` IS NULL
  AND json_valid(`labels_json`)
  AND EXISTS (
    SELECT 1 FROM json_each(`tasks`.`labels_json`) WHERE value = 'saga'
  );
--> statement-breakpoint

-- ── Step 4: Strip 'saga' from labels_json for the just-promoted rows ───
-- Rebuilds labels_json from json_each, filtering out the 'saga' element,
-- then re-aggregating via json_group_array. Guard with json_valid() so a
-- malformed labels_json row does not abort the migration.
UPDATE `tasks`
SET `labels_json` = (
  SELECT COALESCE(json_group_array(value), '[]')
    FROM json_each(`tasks`.`labels_json`)
   WHERE value != 'saga'
)
WHERE `type` = 'saga'
  AND json_valid(`labels_json`)
  AND EXISTS (
    SELECT 1 FROM json_each(`tasks`.`labels_json`) WHERE value = 'saga'
  );
--> statement-breakpoint

-- ── Step 5: Recreate indexes + triggers ────────────────────────────────
-- Index list mirrors the post-T1899 set (idx_tasks_origin included).
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
