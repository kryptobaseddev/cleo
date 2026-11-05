-- T14218 / T14265 (durability Phase 1, finding B-RC1 / fix F1): the two
-- column-scoped task guards fire only on a real change.
--
-- SQLite fires `BEFORE UPDATE OF col` whenever `col` is in the SET list, even
-- when the value is unchanged. Both guards checked NEW only, so a row that
-- predates a guard (a legacy task under a task, or a status/pipeline_stage
-- pair from before T877) refused every later write, a notes edit included.
-- Each guard now also requires that one of its columns changed
-- (`OLD.x IS NOT NEW.x`). A real change into an invalid pair is still refused.
-- The rule text and the suspend clause are unchanged.
--
-- Idempotent (DROP TRIGGER IF EXISTS before each CREATE), and must always RUN:
-- both triggers already exist under the same names, so reconcileJournal would
-- otherwise probe-stamp it without running it.
-- cleo:probe-never-stamp
DROP TRIGGER IF EXISTS `tasks_tasks_parent_type_matrix_update`;
--> statement-breakpoint
CREATE TRIGGER `tasks_tasks_parent_type_matrix_update`
BEFORE UPDATE OF `parent_id`, `type` ON `tasks_tasks`
WHEN (OLD.`parent_id` IS NOT NEW.`parent_id` OR OLD.`type` IS NOT NEW.`type`)
  AND (NEW.`parent_id` IS NOT NULL
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
  ))
  AND NOT EXISTS (SELECT 1 FROM cleo_trigger_suspend WHERE scope IN ('guard', 'all'))
BEGIN
  SELECT RAISE(ABORT, 'E_TASK_PARENT_TYPE_MATRIX: tasks.parent_id must follow saga->epic, epic->task|subtask, and task->subtask; sagas/tasks must be roots');
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_tasks_tasks_status_pipeline_update`;
--> statement-breakpoint
CREATE TRIGGER `trg_tasks_tasks_status_pipeline_update`
BEFORE UPDATE OF `status`, `pipeline_stage` ON `tasks_tasks`
FOR EACH ROW
WHEN (OLD.`status` IS NOT NEW.`status` OR OLD.`pipeline_stage` IS NOT NEW.`pipeline_stage`)
  AND ((NEW.`status` = 'done'      AND (NEW.`pipeline_stage` IS NULL OR NEW.`pipeline_stage` NOT IN ('contribution','cancelled')))
  OR (NEW.`status` = 'cancelled' AND (NEW.`pipeline_stage` IS NULL OR NEW.`pipeline_stage` != 'cancelled')))
  AND NOT EXISTS (SELECT 1 FROM cleo_trigger_suspend WHERE scope IN ('guard', 'all'))
BEGIN
  SELECT RAISE(ABORT, 'T877_INVARIANT_VIOLATION: status/pipeline_stage mismatch. status=done requires pipeline_stage IN (contribution,cancelled); status=cancelled requires pipeline_stage=cancelled.');
END;
