-- T9519 — Add 'groups' to task_relations.relation_type CHECK constraint.
--
-- Background:
--   ADR-073 (Saga) introduces a new 'groups' relation that links a Saga-Epic
--   to its member Epics. This migration adds 'groups' as the 8th valid value
--   in the TASK_RELATION_TYPES tuple and enforces it via a SQL CHECK
--   constraint on task_relations.relation_type.
--
--   Prior to this migration, task_relations.relation_type had NO CHECK
--   constraint (the initial migration used plain `text NOT NULL`). The
--   TASK_RELATION_TYPES TypeScript tuple was the only enforcement layer.
--
-- New valid values (8 total):
--   related | blocks | duplicates | absorbs | fixes | extends | supersedes | groups
--
-- SQLite cannot ADD a CHECK constraint to an existing column, so this
-- migration follows the canonical "table rebuild" recipe
-- (same pattern as T1408 / T9073):
--
--   1. Drop index attached to task_relations.
--   2. Create __new_task_relations with the CHECK-constrained relation_type.
--   3. INSERT … SELECT all rows (no data transformation — all existing values
--      are valid under the new constraint).
--   4. DROP task_relations; RENAME __new_task_relations TO task_relations.
--   5. Recreate the index.
--
-- @task T9519
-- @epic T9518 (Saga epic / ADR-073)

PRAGMA foreign_keys = OFF;
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Step 1 — Drop index attached to task_relations.
-- --------------------------------------------------------------------------
DROP INDEX IF EXISTS `idx_task_relations_related_to`;
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Step 2 — Create __new_task_relations with CHECK-constrained relation_type.
-- --------------------------------------------------------------------------
CREATE TABLE `__new_task_relations` (
  `task_id` text NOT NULL,
  `related_to` text NOT NULL,
  `relation_type` text DEFAULT 'related' NOT NULL
    CHECK (`relation_type` IN (
      'related',
      'blocks',
      'duplicates',
      'absorbs',
      'fixes',
      'extends',
      'supersedes',
      'groups'
    )),
  `reason` text,
  CONSTRAINT `task_relations_pk` PRIMARY KEY(`task_id`, `related_to`),
  CONSTRAINT `fk_task_relations_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_task_relations_related_to_tasks_id_fk` FOREIGN KEY (`related_to`) REFERENCES `tasks`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Step 3 — Copy all rows. Every existing relation_type value is in the
--          allowed set, so no normalization pass is required.
-- --------------------------------------------------------------------------
INSERT INTO `__new_task_relations` (`task_id`, `related_to`, `relation_type`, `reason`)
SELECT `task_id`, `related_to`, `relation_type`, `reason`
FROM `task_relations`;
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Step 4 — Swap tables.
-- --------------------------------------------------------------------------
DROP TABLE `task_relations`;
--> statement-breakpoint
ALTER TABLE `__new_task_relations` RENAME TO `task_relations`;
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Step 5 — Recreate the index.
-- --------------------------------------------------------------------------
CREATE INDEX `idx_task_relations_related_to` ON `task_relations` (`related_to`);
--> statement-breakpoint

PRAGMA foreign_keys = ON;
