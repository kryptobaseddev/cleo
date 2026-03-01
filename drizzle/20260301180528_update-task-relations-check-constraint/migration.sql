-- Update CHECK constraint on task_relations.relation_type to allow all 7 relation types
-- and add reason column. Previous CHECK only allowed: related, blocks, duplicates.
-- New CHECK allows: related, blocks, duplicates, absorbs, fixes, extends, supersedes.
-- SQLite requires table rebuild to modify CHECK constraints.
-- The source table may or may not have a reason column (depending on DB history),
-- so we copy only the 3 guaranteed columns and default reason to NULL.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_task_relations` (
	`task_id` text NOT NULL,
	`related_to` text NOT NULL,
	`relation_type` text DEFAULT 'related' NOT NULL,
	`reason` text,
	CONSTRAINT `task_relations_pk` PRIMARY KEY(`task_id`, `related_to`),
	CONSTRAINT `fk_task_relations_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_task_relations_related_to_tasks_id_fk` FOREIGN KEY (`related_to`) REFERENCES `tasks`(`id`) ON DELETE CASCADE,
	CONSTRAINT "chk_task_relations_relation_type" CHECK("relation_type" IN ('related','blocks','duplicates','absorbs','fixes','extends','supersedes'))
);--> statement-breakpoint
INSERT INTO `__new_task_relations`(`task_id`, `related_to`, `relation_type`) SELECT `task_id`, `related_to`, `relation_type` FROM `task_relations`;--> statement-breakpoint
DROP TABLE `task_relations`;--> statement-breakpoint
ALTER TABLE `__new_task_relations` RENAME TO `task_relations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
