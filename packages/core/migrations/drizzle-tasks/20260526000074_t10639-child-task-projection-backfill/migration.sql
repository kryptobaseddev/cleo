-- T10639 — Backfill child_task AC projection rows for every parent task.
--
-- PM-Core V2 (ADR-088): parent tasks expose their direct children as typed
-- child_task acceptance criteria. The in-memory dual-write in addTask()
-- (packages/core/src/tasks/add.ts) creates these projections for newly-added
-- children, but parent-child relationships that existed before the dual-write
-- went live do not have corresponding child_task rows in
-- task_acceptance_criteria.
--
-- This migration backfills those missing projections. For every task that
-- has direct children (via tasks.parent_id), one child_task typed AC row
-- is created per child that doesn't already have one.
--
-- ## Row shape (matching in-memory code in ac-table.ts)
--
--   kind           = 'child_task'
--   source_key     = 'child:<childId>'     (childProjectionSourceKey)
--   target_task_id = <childId>
--   projection     = 'parent-child'
--   text           = 'Complete child <childId>: <childTitle>'
--                     (buildChildProjectionAcText)
--   content_hash   = NULL                  (SHA-256 unavailable in SQLite;
--                                           in-memory code recalculates
--                                           on first audit/rebuild)
--   id             = UUIDv4 (pure SQL, matching T10505 pattern)
--   ordinal        = max(parent-existing) + row_number (per parent)
--
-- ## Idempotency
--
-- The NOT EXISTS gate on (task_id, source_key) prevents duplicate rows when
-- the migration is re-applied. The history insert is gated by (ac_id, reason)
-- so repeated runs produce zero new rows.
--
-- ## Revert safety
--
-- The revert deletes rows whose history entry carries reason='backfill',
-- matching the T10505 revert pattern. Forward-migration-only rows
-- (created by normal addTask/reparet operations) have history rows
-- with reason='edit' or 'projection_rebuild' and are preserved.
--
-- @task  T10639
-- @saga  T10538
-- @epic  T10548
-- @adr   ADR-088

-- ── Step 1: Insert child_task rows for unrepresented parent→child pairs ──
WITH parent_children AS (
  SELECT
    parent.`id`                        AS parent_id,
    child.`id`                         AS child_id,
    COALESCE(child.`title`, '')        AS child_title
  FROM `tasks` parent
  JOIN `tasks` child ON child.`parent_id` = parent.`id`
  WHERE NOT EXISTS (
    SELECT 1
      FROM `task_acceptance_criteria` ac
     WHERE ac.`task_id`     = parent.`id`
       AND ac.`source_key`  = 'child:' || child.`id`
  )
)
INSERT INTO `task_acceptance_criteria` (
  `id`,
  `task_id`,
  `ordinal`,
  `kind`,
  `source_key`,
  `target_task_id`,
  `projection`,
  `text`,
  `content_hash`
)
SELECT
  -- UUIDv4 in pure SQL (RFC 4122 §4.4 variant matching T10505 pattern).
  -- Collision probability ≈ 2⁻¹²² — astronomically safe for PK space.
  printf(
    '%s-%s-4%s-%s%s-%s',
    lower(hex(randomblob(4))),
    lower(hex(randomblob(2))),
    substr(lower(hex(randomblob(2))), 2, 3),
    substr('89ab', abs(random()) % 4 + 1, 1),
    substr(lower(hex(randomblob(2))), 2, 3),
    lower(hex(randomblob(6)))
  ),
  parent_id,
  -- Ordinal: append AFTER the parent's existing AC rows so child_task
  -- projections never displace text/evidence_bound criteria. When the
  -- parent has no existing AC rows, the first child gets ordinal 1.
  COALESCE(
    (SELECT MAX(existing.`ordinal`)
       FROM `task_acceptance_criteria` existing
      WHERE existing.`task_id` = parent_id),
    0
  ) + ROW_NUMBER() OVER (PARTITION BY parent_id ORDER BY child_id),
  'child_task',
  'child:' || child_id,
  child_id,
  'parent-child',
  'Complete child ' || child_id || ': ' || child_title,
  NULL   -- SHA-256 not available in SQLite (in-memory code recalculates)
FROM parent_children;
--> statement-breakpoint

-- ── Step 2: Record backfill history for every newly-created projection ──
INSERT INTO `task_acceptance_criteria_history` (`ac_id`, `previous_text`, `reason`)
SELECT
  ac.`id`,
  ac.`text`,
  'backfill'
FROM `task_acceptance_criteria` ac
WHERE ac.`kind` = 'child_task'
  AND ac.`projection` = 'parent-child'
  AND ac.`content_hash` IS NULL          -- marker: migration-created rows
  AND NOT EXISTS (
    SELECT 1
      FROM `task_acceptance_criteria_history` h
     WHERE h.`ac_id`  = ac.`id`
       AND h.`reason` = 'backfill'
  );
