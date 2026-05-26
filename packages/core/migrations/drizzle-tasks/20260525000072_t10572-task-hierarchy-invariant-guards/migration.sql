-- T10572 — Guard task hierarchy invariants at the SQLite boundary.
--
-- PM-Core V2 keeps containment in tasks.parent_id and reserves task_relations
-- for non-containment edges. Drizzle cannot express SQLite triggers in the table
-- schema, so these raw SQL guards are the database SSoT for cross-row hierarchy
-- invariants that must also protect direct SQL callers:
--   - task_relations cannot duplicate parent/child containment edges
--   - task_acceptance_criteria child_task targets must point at direct children
--   - tasks.parent_id must obey the Epic -> Task|Subtask and Task -> Subtask type matrix
--   - tasks.parent_id updates cannot introduce containment cycles
-- Trigger messages are intentionally prefixed with stable error codes so CLI
-- callers can surface actionable remediation.
--
-- @task T10572
-- @saga T10538

DROP TRIGGER IF EXISTS `task_relations_non_containment_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `task_relations_non_containment_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tasks_parent_type_matrix_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tasks_parent_type_matrix_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `task_acceptance_child_target_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `task_acceptance_child_target_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tasks_parent_cycle_guard_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tasks_parent_cycle_guard_update`;
--> statement-breakpoint

CREATE TRIGGER `task_relations_non_containment_insert`
BEFORE INSERT ON `task_relations`
WHEN EXISTS (
  SELECT 1
  FROM `tasks` child
  WHERE child.`id` = NEW.`task_id`
    AND child.`parent_id` = NEW.`related_to`
) OR EXISTS (
  SELECT 1
  FROM `tasks` child
  WHERE child.`id` = NEW.`related_to`
    AND child.`parent_id` = NEW.`task_id`
)
BEGIN
  SELECT RAISE(ABORT, 'E_TASK_RELATION_CONTAINMENT: task_relations is non-containment-only; use tasks.parent_id for parent/child edges');
END;
--> statement-breakpoint

CREATE TRIGGER `task_relations_non_containment_update`
BEFORE UPDATE OF `task_id`, `related_to` ON `task_relations`
WHEN EXISTS (
  SELECT 1
  FROM `tasks` child
  WHERE child.`id` = NEW.`task_id`
    AND child.`parent_id` = NEW.`related_to`
) OR EXISTS (
  SELECT 1
  FROM `tasks` child
  WHERE child.`id` = NEW.`related_to`
    AND child.`parent_id` = NEW.`task_id`
)
BEGIN
  SELECT RAISE(ABORT, 'E_TASK_RELATION_CONTAINMENT: task_relations is non-containment-only; use tasks.parent_id for parent/child edges');
END;
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
        (NEW.`type` = 'task' AND parent.`type` = 'epic')
        OR (NEW.`type` = 'subtask' AND parent.`type` IN ('epic', 'task'))
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'E_TASK_PARENT_TYPE_MATRIX: tasks.parent_id must follow epic->task|subtask and task->subtask; sagas/epics must be roots and saga membership uses task_relations.groups');
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
        (NEW.`type` = 'task' AND parent.`type` = 'epic')
        OR (NEW.`type` = 'subtask' AND parent.`type` IN ('epic', 'task'))
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'E_TASK_PARENT_TYPE_MATRIX: tasks.parent_id must follow epic->task|subtask and task->subtask; sagas/epics must be roots and saga membership uses task_relations.groups');
END;
--> statement-breakpoint

CREATE TRIGGER `task_acceptance_child_target_insert`
BEFORE INSERT ON `task_acceptance_criteria`
WHEN NEW.`target_task_id` IS NOT NULL
  AND (
    NEW.`kind` <> 'child_task'
    OR NOT EXISTS (
      SELECT 1
      FROM `tasks` child
      WHERE child.`id` = NEW.`target_task_id`
        AND child.`parent_id` = NEW.`task_id`
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'E_CHILD_TASK_TARGET_CONTAINMENT: child_task acceptance target_task_id must be a direct child of task_id; non-child_task criteria must not set target_task_id');
END;
--> statement-breakpoint

CREATE TRIGGER `task_acceptance_child_target_update`
BEFORE UPDATE OF `task_id`, `kind`, `target_task_id` ON `task_acceptance_criteria`
WHEN NEW.`target_task_id` IS NOT NULL
  AND (
    NEW.`kind` <> 'child_task'
    OR NOT EXISTS (
      SELECT 1
      FROM `tasks` child
      WHERE child.`id` = NEW.`target_task_id`
        AND child.`parent_id` = NEW.`task_id`
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'E_CHILD_TASK_TARGET_CONTAINMENT: child_task acceptance target_task_id must be a direct child of task_id; non-child_task criteria must not set target_task_id');
END;
--> statement-breakpoint

CREATE TRIGGER `tasks_parent_cycle_guard_insert`
BEFORE INSERT ON `tasks`
WHEN NEW.`parent_id` IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'E_TASK_PARENT_CYCLE: tasks.parent_id cannot create a containment cycle')
  WHERE EXISTS (
    WITH RECURSIVE ancestors(`id`, `parent_id`) AS (
      SELECT parent.`id`, parent.`parent_id`
      FROM `tasks` parent
      WHERE parent.`id` = NEW.`parent_id`
      UNION ALL
      SELECT next_parent.`id`, next_parent.`parent_id`
      FROM `tasks` next_parent
      JOIN ancestors ON next_parent.`id` = ancestors.`parent_id`
      WHERE ancestors.`parent_id` IS NOT NULL
    )
    SELECT 1 FROM ancestors WHERE ancestors.`id` = NEW.`id`
  );
END;
--> statement-breakpoint

CREATE TRIGGER `tasks_parent_cycle_guard_update`
BEFORE UPDATE OF `parent_id` ON `tasks`
WHEN NEW.`parent_id` IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'E_TASK_PARENT_CYCLE: tasks.parent_id cannot create a containment cycle')
  WHERE EXISTS (
    WITH RECURSIVE ancestors(`id`, `parent_id`) AS (
      SELECT parent.`id`, parent.`parent_id`
      FROM `tasks` parent
      WHERE parent.`id` = NEW.`parent_id`
      UNION ALL
      SELECT next_parent.`id`, next_parent.`parent_id`
      FROM `tasks` next_parent
      JOIN ancestors ON next_parent.`id` = ancestors.`parent_id`
      WHERE ancestors.`parent_id` IS NOT NULL
    )
    SELECT 1 FROM ancestors WHERE ancestors.`id` = NEW.`id`
  );
END;
