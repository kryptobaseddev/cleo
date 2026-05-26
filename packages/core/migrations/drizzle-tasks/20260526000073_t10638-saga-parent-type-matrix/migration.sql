-- T10638 — Extend tasks.parent_id type matrix to accept saga->epic containment.
--
-- After T10636 (type='saga' migration) and T10637 (parent_id containment
-- migration), saga membership uses tasks.parent_id instead of
-- task_relations.type='groups'. The existing type-matrix triggers reject
-- epic->saga parent_id edges. This migration drops and recreates the
-- insert+update triggers to add saga as an accepted parent type for epics.
--
-- Allowed parent/child type pairs (post-T10638):
--   saga -> epic    (saga membership — NEW)
--   epic -> task    (existing)
--   epic -> subtask (existing)
--   task -> subtask (existing)
--
-- Sagas remain roots (parent_id must be NULL), tasks can only be children
-- of epics, and subtasks can only be children of epics or tasks.
--
-- @task T10638
-- @saga T10538

DROP TRIGGER IF EXISTS `tasks_parent_type_matrix_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tasks_parent_type_matrix_update`;
--> statement-breakpoint

CREATE TRIGGER `tasks_parent_type_matrix_insert`
BEFORE INSERT ON `tasks`
WHEN NEW.`parent_id` IS NOT NULL
  AND NEW.`type` IS NOT NULL
  AND EXISTS (SELECT 1 FROM `tasks` parent WHERE parent.`id` = NEW.`parent_id` AND parent.`type` IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1
    FROM `tasks` parent
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

CREATE TRIGGER `tasks_parent_type_matrix_update`
BEFORE UPDATE OF `parent_id`, `type` ON `tasks`
WHEN NEW.`parent_id` IS NOT NULL
  AND NEW.`type` IS NOT NULL
  AND EXISTS (SELECT 1 FROM `tasks` parent WHERE parent.`id` = NEW.`parent_id` AND parent.`type` IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1
    FROM `tasks` parent
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
