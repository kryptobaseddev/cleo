-- Revert T12886 — drop the dependency-cycle guard triggers.
--
-- @task T12886

DROP TRIGGER IF EXISTS `tasks_task_dependencies_cycle_guard_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tasks_task_dependencies_cycle_guard_update`;
