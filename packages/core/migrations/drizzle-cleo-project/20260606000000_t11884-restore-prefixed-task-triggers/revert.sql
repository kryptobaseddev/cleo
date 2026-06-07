-- Revert T11884 — drop the prefixed-table invariant + handoff triggers.
-- The legacy bare-table triggers are untouched (they remain the active guards
-- until the E5 cutover drops the bare tables).
--
-- @task T11884

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
