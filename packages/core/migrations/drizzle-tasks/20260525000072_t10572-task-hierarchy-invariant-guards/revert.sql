-- Revert T10572 task hierarchy invariant trigger guards.

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
