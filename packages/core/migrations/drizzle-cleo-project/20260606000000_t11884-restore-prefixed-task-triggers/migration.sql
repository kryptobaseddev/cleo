-- T11884 — Restore task-domain invariant + handoff triggers on the PREFIXED tables.
--
-- ==========================================================================
-- Problem (latent bug exposed by the SG-DB-SUBSTRATE-V2 cutover)
-- ==========================================================================
-- The T11578 dual-scope cutover repointed the runtime drizzle symbols
-- (`tasks`, `task_relations`, `task_acceptance_criteria`, session handoff, …)
-- from the BARE un-prefixed tables onto the domain-prefixed tables
-- (`tasks_tasks`, `tasks_task_relations`, …). But the 12 SQLite invariant /
-- handoff triggers were authored ONLY on the bare tables (T877, T10572,
-- T10638, T1609) and were never recreated on the prefixed tables — exodus
-- copies rows with triggers absent on the target. Result: every task invariant
-- has been SILENTLY UNENFORCED on the live write path (`tasks_tasks` has zero
-- triggers), and the session-handoff `handoff_json` mirror is dead.
--
-- This migration recreates all 12 guards on the prefixed tables, with bodies
-- rewritten to reference `tasks_tasks` / `tasks_sessions`. New trigger NAMES
-- are used (prefixed) so they do NOT collide with the still-present legacy
-- triggers; when the legacy bare tables are dropped (E5 of the cutover) their
-- triggers drop with them and these remain the SSoT.
--
-- Invariants restored:
--   - tasks_tasks.parent_id cannot introduce a containment cycle
--   - tasks_tasks.parent_id obeys the saga->epic, epic->task|subtask,
--     task->subtask type matrix (sagas/tasks are roots)
--   - tasks_tasks status/pipeline_stage T877 invariant
--   - tasks_task_relations is non-containment-only
--   - tasks_task_acceptance_criteria child_task targets must be direct children
--   - tasks_session_handoff_entries is write-once + mirrors handoff_json into
--     tasks_sessions
--
-- Trigger messages keep the same stable error codes so CLI callers surface
-- identical remediation regardless of which physical table fired.
--
-- @task T11884
-- @epic T11883
-- @saga T11242

DROP TRIGGER IF EXISTS `tasks_tasks_parent_cycle_guard_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tasks_tasks_parent_cycle_guard_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tasks_tasks_parent_type_matrix_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tasks_tasks_parent_type_matrix_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_tasks_tasks_status_pipeline_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_tasks_tasks_status_pipeline_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tasks_task_relations_non_containment_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tasks_task_relations_non_containment_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tasks_task_acceptance_child_target_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tasks_task_acceptance_child_target_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_tasks_session_handoff_mirror`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_tasks_session_handoff_no_update`;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Parent-cycle guard (T10572) — tasks_tasks
-- ---------------------------------------------------------------------------
CREATE TRIGGER `tasks_tasks_parent_cycle_guard_insert`
BEFORE INSERT ON `tasks_tasks`
WHEN NEW.`parent_id` IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'E_TASK_PARENT_CYCLE: tasks.parent_id cannot create a containment cycle')
  WHERE EXISTS (
    WITH RECURSIVE ancestors(`id`, `parent_id`) AS (
      SELECT parent.`id`, parent.`parent_id`
      FROM `tasks_tasks` parent
      WHERE parent.`id` = NEW.`parent_id`
      UNION ALL
      SELECT next_parent.`id`, next_parent.`parent_id`
      FROM `tasks_tasks` next_parent
      JOIN ancestors ON next_parent.`id` = ancestors.`parent_id`
      WHERE ancestors.`parent_id` IS NOT NULL
    )
    SELECT 1 FROM ancestors WHERE ancestors.`id` = NEW.`id`
  );
END;
--> statement-breakpoint

CREATE TRIGGER `tasks_tasks_parent_cycle_guard_update`
BEFORE UPDATE OF `parent_id` ON `tasks_tasks`
WHEN NEW.`parent_id` IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'E_TASK_PARENT_CYCLE: tasks.parent_id cannot create a containment cycle')
  WHERE EXISTS (
    WITH RECURSIVE ancestors(`id`, `parent_id`) AS (
      SELECT parent.`id`, parent.`parent_id`
      FROM `tasks_tasks` parent
      WHERE parent.`id` = NEW.`parent_id`
      UNION ALL
      SELECT next_parent.`id`, next_parent.`parent_id`
      FROM `tasks_tasks` next_parent
      JOIN ancestors ON next_parent.`id` = ancestors.`parent_id`
      WHERE ancestors.`parent_id` IS NOT NULL
    )
    SELECT 1 FROM ancestors WHERE ancestors.`id` = NEW.`id`
  );
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Parent type-matrix guard (T10638) — tasks_tasks
-- ---------------------------------------------------------------------------
CREATE TRIGGER `tasks_tasks_parent_type_matrix_insert`
BEFORE INSERT ON `tasks_tasks`
WHEN NEW.`parent_id` IS NOT NULL
  AND NEW.`type` IS NOT NULL
  AND EXISTS (SELECT 1 FROM `tasks_tasks` parent WHERE parent.`id` = NEW.`parent_id` AND parent.`type` IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1
    FROM `tasks_tasks` parent
    WHERE parent.`id` = NEW.`parent_id`
      AND (
        (NEW.`type` = 'epic'  AND parent.`type` = 'saga')
        OR (NEW.`type` = 'task'   AND parent.`type` = 'epic')
        OR (NEW.`type` = 'subtask' AND parent.`type` IN ('epic', 'task'))
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'E_TASK_PARENT_TYPE_MATRIX: tasks.parent_id must follow saga->epic, epic->task|subtask, and task->subtask; sagas/tasks must be roots');
END;
--> statement-breakpoint

CREATE TRIGGER `tasks_tasks_parent_type_matrix_update`
BEFORE UPDATE OF `parent_id`, `type` ON `tasks_tasks`
WHEN NEW.`parent_id` IS NOT NULL
  AND NEW.`type` IS NOT NULL
  AND EXISTS (SELECT 1 FROM `tasks_tasks` parent WHERE parent.`id` = NEW.`parent_id` AND parent.`type` IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1
    FROM `tasks_tasks` parent
    WHERE parent.`id` = NEW.`parent_id`
      AND (
        (NEW.`type` = 'epic'  AND parent.`type` = 'saga')
        OR (NEW.`type` = 'task'   AND parent.`type` = 'epic')
        OR (NEW.`type` = 'subtask' AND parent.`type` IN ('epic', 'task'))
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'E_TASK_PARENT_TYPE_MATRIX: tasks.parent_id must follow saga->epic, epic->task|subtask, and task->subtask; sagas/tasks must be roots');
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Status / pipeline_stage invariant (T877) — tasks_tasks
-- ---------------------------------------------------------------------------
CREATE TRIGGER `trg_tasks_tasks_status_pipeline_insert`
BEFORE INSERT ON `tasks_tasks`
FOR EACH ROW
WHEN (NEW.`status` = 'done'      AND (NEW.`pipeline_stage` IS NULL OR NEW.`pipeline_stage` NOT IN ('contribution','cancelled')))
  OR (NEW.`status` = 'cancelled' AND (NEW.`pipeline_stage` IS NULL OR NEW.`pipeline_stage` != 'cancelled'))
BEGIN
  SELECT RAISE(ABORT, 'T877_INVARIANT_VIOLATION: status/pipeline_stage mismatch. status=done requires pipeline_stage IN (contribution,cancelled); status=cancelled requires pipeline_stage=cancelled.');
END;
--> statement-breakpoint

CREATE TRIGGER `trg_tasks_tasks_status_pipeline_update`
BEFORE UPDATE OF `status`, `pipeline_stage` ON `tasks_tasks`
FOR EACH ROW
WHEN (NEW.`status` = 'done'      AND (NEW.`pipeline_stage` IS NULL OR NEW.`pipeline_stage` NOT IN ('contribution','cancelled')))
  OR (NEW.`status` = 'cancelled' AND (NEW.`pipeline_stage` IS NULL OR NEW.`pipeline_stage` != 'cancelled'))
BEGIN
  SELECT RAISE(ABORT, 'T877_INVARIANT_VIOLATION: status/pipeline_stage mismatch. status=done requires pipeline_stage IN (contribution,cancelled); status=cancelled requires pipeline_stage=cancelled.');
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Non-containment guard (T10572) — tasks_task_relations
-- ---------------------------------------------------------------------------
CREATE TRIGGER `tasks_task_relations_non_containment_insert`
BEFORE INSERT ON `tasks_task_relations`
WHEN EXISTS (
  SELECT 1
  FROM `tasks_tasks` child
  WHERE child.`id` = NEW.`task_id`
    AND child.`parent_id` = NEW.`related_to`
) OR EXISTS (
  SELECT 1
  FROM `tasks_tasks` child
  WHERE child.`id` = NEW.`related_to`
    AND child.`parent_id` = NEW.`task_id`
)
BEGIN
  SELECT RAISE(ABORT, 'E_TASK_RELATION_CONTAINMENT: task_relations is non-containment-only; use tasks.parent_id for parent/child edges');
END;
--> statement-breakpoint

CREATE TRIGGER `tasks_task_relations_non_containment_update`
BEFORE UPDATE OF `task_id`, `related_to` ON `tasks_task_relations`
WHEN EXISTS (
  SELECT 1
  FROM `tasks_tasks` child
  WHERE child.`id` = NEW.`task_id`
    AND child.`parent_id` = NEW.`related_to`
) OR EXISTS (
  SELECT 1
  FROM `tasks_tasks` child
  WHERE child.`id` = NEW.`related_to`
    AND child.`parent_id` = NEW.`task_id`
)
BEGIN
  SELECT RAISE(ABORT, 'E_TASK_RELATION_CONTAINMENT: task_relations is non-containment-only; use tasks.parent_id for parent/child edges');
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Acceptance child_target containment guard (T10572) — tasks_task_acceptance_criteria
-- ---------------------------------------------------------------------------
CREATE TRIGGER `tasks_task_acceptance_child_target_insert`
BEFORE INSERT ON `tasks_task_acceptance_criteria`
WHEN NEW.`target_task_id` IS NOT NULL
  AND (
    NEW.`kind` <> 'child_task'
    OR NOT EXISTS (
      SELECT 1
      FROM `tasks_tasks` child
      WHERE child.`id` = NEW.`target_task_id`
        AND child.`parent_id` = NEW.`task_id`
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'E_CHILD_TASK_TARGET_CONTAINMENT: child_task acceptance target_task_id must be a direct child of task_id; non-child_task criteria must not set target_task_id');
END;
--> statement-breakpoint

CREATE TRIGGER `tasks_task_acceptance_child_target_update`
BEFORE UPDATE OF `task_id`, `kind`, `target_task_id` ON `tasks_task_acceptance_criteria`
WHEN NEW.`target_task_id` IS NOT NULL
  AND (
    NEW.`kind` <> 'child_task'
    OR NOT EXISTS (
      SELECT 1
      FROM `tasks_tasks` child
      WHERE child.`id` = NEW.`target_task_id`
        AND child.`parent_id` = NEW.`task_id`
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'E_CHILD_TASK_TARGET_CONTAINMENT: child_task acceptance target_task_id must be a direct child of task_id; non-child_task criteria must not set target_task_id');
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Session-handoff write-once + mirror (T1609) — tasks_session_handoff_entries
-- ---------------------------------------------------------------------------
CREATE TRIGGER `trg_tasks_session_handoff_mirror`
AFTER INSERT ON `tasks_session_handoff_entries`
FOR EACH ROW
BEGIN
  UPDATE `tasks_sessions`
     SET `handoff_json` = NEW.handoff_json
   WHERE `id` = NEW.session_id;
END;
--> statement-breakpoint

CREATE TRIGGER `trg_tasks_session_handoff_no_update`
BEFORE UPDATE ON `tasks_session_handoff_entries`
FOR EACH ROW
BEGIN
  SELECT RAISE(
    ABORT,
    'T1609_HANDOFF_IMMUTABLE: session_handoff_entries rows are write-once. Use persistHandoff() exactly once per session.'
  );
END;
