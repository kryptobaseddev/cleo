PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_lifecycle_evidence` (
	`id` text PRIMARY KEY,
	`stage_id` text NOT NULL,
	`uri` text NOT NULL,
	`type` text NOT NULL,
	`recorded_at` text DEFAULT (datetime('now')) NOT NULL,
	`recorded_by` text,
	`description` text,
	CONSTRAINT `fk_lifecycle_evidence_stage_id_lifecycle_stages_id_fk` FOREIGN KEY (`stage_id`) REFERENCES `lifecycle_stages`(`id`) ON DELETE CASCADE,
	CONSTRAINT "chk_lifecycle_evidence_type" CHECK("type" IN ('file','url','manifest'))
);
--> statement-breakpoint
INSERT INTO `__new_lifecycle_evidence`(`id`, `stage_id`, `uri`, `type`, `recorded_at`, `recorded_by`, `description`) SELECT `id`, `stage_id`, `uri`, `type`, `recorded_at`, `recorded_by`, `description` FROM `lifecycle_evidence`;--> statement-breakpoint
DROP TABLE `lifecycle_evidence`;--> statement-breakpoint
ALTER TABLE `__new_lifecycle_evidence` RENAME TO `lifecycle_evidence`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_lifecycle_gate_results` (
	`id` text PRIMARY KEY,
	`stage_id` text NOT NULL,
	`gate_name` text NOT NULL,
	`result` text NOT NULL,
	`checked_at` text DEFAULT (datetime('now')) NOT NULL,
	`checked_by` text NOT NULL,
	`details` text,
	`reason` text,
	CONSTRAINT `fk_lifecycle_gate_results_stage_id_lifecycle_stages_id_fk` FOREIGN KEY (`stage_id`) REFERENCES `lifecycle_stages`(`id`) ON DELETE CASCADE,
	CONSTRAINT "chk_lifecycle_gate_results_result" CHECK("result" IN ('pass','fail','warn'))
);
--> statement-breakpoint
INSERT INTO `__new_lifecycle_gate_results`(`id`, `stage_id`, `gate_name`, `result`, `checked_at`, `checked_by`, `details`, `reason`) SELECT `id`, `stage_id`, `gate_name`, `result`, `checked_at`, `checked_by`, `details`, `reason` FROM `lifecycle_gate_results`;--> statement-breakpoint
DROP TABLE `lifecycle_gate_results`;--> statement-breakpoint
ALTER TABLE `__new_lifecycle_gate_results` RENAME TO `lifecycle_gate_results`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_lifecycle_pipelines` (
	`id` text PRIMARY KEY,
	`task_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`current_stage_id` text,
	`started_at` text DEFAULT (datetime('now')) NOT NULL,
	`completed_at` text,
	CONSTRAINT `fk_lifecycle_pipelines_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE,
	CONSTRAINT "chk_lifecycle_pipelines_status" CHECK("status" IN ('active','completed','aborted'))
);
--> statement-breakpoint
INSERT INTO `__new_lifecycle_pipelines`(`id`, `task_id`, `status`, `current_stage_id`, `started_at`, `completed_at`) SELECT `id`, `task_id`, `status`, `current_stage_id`, `started_at`, `completed_at` FROM `lifecycle_pipelines`;--> statement-breakpoint
DROP TABLE `lifecycle_pipelines`;--> statement-breakpoint
ALTER TABLE `__new_lifecycle_pipelines` RENAME TO `lifecycle_pipelines`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_lifecycle_stages` (
	`id` text PRIMARY KEY,
	`pipeline_id` text NOT NULL,
	`stage_name` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`sequence` integer NOT NULL,
	`started_at` text,
	`completed_at` text,
	`blocked_at` text,
	`block_reason` text,
	`skipped_at` text,
	`skip_reason` text,
	`notes_json` text DEFAULT '[]',
	`metadata_json` text DEFAULT '{}',
	CONSTRAINT `fk_lifecycle_stages_pipeline_id_lifecycle_pipelines_id_fk` FOREIGN KEY (`pipeline_id`) REFERENCES `lifecycle_pipelines`(`id`) ON DELETE CASCADE,
	CONSTRAINT "chk_lifecycle_stages_stage_name" CHECK("stage_name" IN ('research','consensus','specification','decomposition','implementation','validation','testing','release')),
	CONSTRAINT "chk_lifecycle_stages_status" CHECK("status" IN ('pending','active','blocked','completed','skipped'))
);
--> statement-breakpoint
INSERT INTO `__new_lifecycle_stages`(`id`, `pipeline_id`, `stage_name`, `status`, `sequence`, `started_at`, `completed_at`, `blocked_at`, `block_reason`, `skipped_at`, `skip_reason`, `notes_json`, `metadata_json`) SELECT `id`, `pipeline_id`, `stage_name`, `status`, `sequence`, `started_at`, `completed_at`, `blocked_at`, `block_reason`, `skipped_at`, `skip_reason`, `notes_json`, `metadata_json` FROM `lifecycle_stages`;--> statement-breakpoint
DROP TABLE `lifecycle_stages`;--> statement-breakpoint
ALTER TABLE `__new_lifecycle_stages` RENAME TO `lifecycle_stages`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_lifecycle_transitions` (
	`id` text PRIMARY KEY,
	`pipeline_id` text NOT NULL,
	`from_stage_id` text NOT NULL,
	`to_stage_id` text NOT NULL,
	`transition_type` text DEFAULT 'automatic' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `fk_lifecycle_transitions_pipeline_id_lifecycle_pipelines_id_fk` FOREIGN KEY (`pipeline_id`) REFERENCES `lifecycle_pipelines`(`id`) ON DELETE CASCADE,
	CONSTRAINT "chk_lifecycle_transitions_transition_type" CHECK("transition_type" IN ('automatic','manual','forced'))
);
--> statement-breakpoint
INSERT INTO `__new_lifecycle_transitions`(`id`, `pipeline_id`, `from_stage_id`, `to_stage_id`, `transition_type`, `created_at`) SELECT `id`, `pipeline_id`, `from_stage_id`, `to_stage_id`, `transition_type`, `created_at` FROM `lifecycle_transitions`;--> statement-breakpoint
DROP TABLE `lifecycle_transitions`;--> statement-breakpoint
ALTER TABLE `__new_lifecycle_transitions` RENAME TO `lifecycle_transitions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sessions` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`scope_json` text DEFAULT '{}' NOT NULL,
	`current_task` text,
	`task_started_at` text,
	`agent` text,
	`notes_json` text DEFAULT '[]',
	`tasks_completed_json` text DEFAULT '[]',
	`tasks_created_json` text DEFAULT '[]',
	`started_at` text DEFAULT (datetime('now')) NOT NULL,
	`ended_at` text,
	CONSTRAINT "chk_sessions_status" CHECK("status" IN ('active','ended','orphaned','suspended'))
);
--> statement-breakpoint
INSERT INTO `__new_sessions`(`id`, `name`, `status`, `scope_json`, `current_task`, `task_started_at`, `agent`, `notes_json`, `tasks_completed_json`, `tasks_created_json`, `started_at`, `ended_at`) SELECT `id`, `name`, `status`, `scope_json`, `current_task`, `task_started_at`, `agent`, `notes_json`, `tasks_completed_json`, `tasks_created_json`, `started_at`, `ended_at` FROM `sessions`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
ALTER TABLE `__new_sessions` RENAME TO `sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_task_relations` (
	`task_id` text NOT NULL,
	`related_to` text NOT NULL,
	`relation_type` text DEFAULT 'related' NOT NULL,
	CONSTRAINT `task_relations_pk` PRIMARY KEY(`task_id`, `related_to`),
	CONSTRAINT `fk_task_relations_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_task_relations_related_to_tasks_id_fk` FOREIGN KEY (`related_to`) REFERENCES `tasks`(`id`) ON DELETE CASCADE,
	CONSTRAINT "chk_task_relations_relation_type" CHECK("relation_type" IN ('related','blocks','duplicates'))
);
--> statement-breakpoint
INSERT INTO `__new_task_relations`(`task_id`, `related_to`, `relation_type`) SELECT `task_id`, `related_to`, `relation_type` FROM `task_relations`;--> statement-breakpoint
DROP TABLE `task_relations`;--> statement-breakpoint
ALTER TABLE `__new_task_relations` RENAME TO `task_relations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tasks` (
	`id` text PRIMARY KEY,
	`title` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`priority` text DEFAULT 'medium' NOT NULL,
	`type` text,
	`parent_id` text,
	`phase` text,
	`size` text,
	`position` integer,
	`position_version` integer DEFAULT 0,
	`labels_json` text DEFAULT '[]',
	`notes_json` text DEFAULT '[]',
	`acceptance_json` text DEFAULT '[]',
	`files_json` text DEFAULT '[]',
	`origin` text,
	`blocked_by` text,
	`epic_lifecycle` text,
	`no_auto_complete` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text,
	`completed_at` text,
	`cancelled_at` text,
	`cancellation_reason` text,
	`archived_at` text,
	`archive_reason` text,
	`cycle_time_days` integer,
	`verification_json` text,
	`created_by` text,
	`modified_by` text,
	`session_id` text,
	CONSTRAINT `fk_tasks_parent_id_tasks_id_fk` FOREIGN KEY (`parent_id`) REFERENCES `tasks`(`id`),
	CONSTRAINT "chk_tasks_status" CHECK("status" IN ('pending','active','blocked','done','cancelled','archived')),
	CONSTRAINT "chk_tasks_priority" CHECK("priority" IN ('critical','high','medium','low')),
	CONSTRAINT "chk_tasks_type" CHECK("type" IN ('epic','task','subtask') OR "type" IS NULL),
	CONSTRAINT "chk_tasks_size" CHECK("size" IN ('small','medium','large') OR "size" IS NULL)
);
--> statement-breakpoint
INSERT INTO `__new_tasks`(`id`, `title`, `description`, `status`, `priority`, `type`, `parent_id`, `phase`, `size`, `position`, `position_version`, `labels_json`, `notes_json`, `acceptance_json`, `files_json`, `origin`, `blocked_by`, `epic_lifecycle`, `no_auto_complete`, `created_at`, `updated_at`, `completed_at`, `cancelled_at`, `cancellation_reason`, `archived_at`, `archive_reason`, `cycle_time_days`, `verification_json`, `created_by`, `modified_by`, `session_id`) SELECT `id`, `title`, `description`, `status`, `priority`, `type`, `parent_id`, `phase`, `size`, `position`, `position_version`, `labels_json`, `notes_json`, `acceptance_json`, `files_json`, `origin`, `blocked_by`, `epic_lifecycle`, `no_auto_complete`, `created_at`, `updated_at`, `completed_at`, `cancelled_at`, `cancellation_reason`, `archived_at`, `archive_reason`, `cycle_time_days`, `verification_json`, `created_by`, `modified_by`, `session_id` FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_lifecycle_evidence_stage_id` ON `lifecycle_evidence` (`stage_id`);--> statement-breakpoint
CREATE INDEX `idx_lifecycle_gate_results_stage_id` ON `lifecycle_gate_results` (`stage_id`);--> statement-breakpoint
CREATE INDEX `idx_lifecycle_pipelines_task_id` ON `lifecycle_pipelines` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_lifecycle_pipelines_status` ON `lifecycle_pipelines` (`status`);--> statement-breakpoint
CREATE INDEX `idx_lifecycle_stages_pipeline_id` ON `lifecycle_stages` (`pipeline_id`);--> statement-breakpoint
CREATE INDEX `idx_lifecycle_stages_stage_name` ON `lifecycle_stages` (`stage_name`);--> statement-breakpoint
CREATE INDEX `idx_lifecycle_stages_status` ON `lifecycle_stages` (`status`);--> statement-breakpoint
CREATE INDEX `idx_lifecycle_transitions_pipeline_id` ON `lifecycle_transitions` (`pipeline_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_status` ON `sessions` (`status`);--> statement-breakpoint
CREATE INDEX `idx_tasks_status` ON `tasks` (`status`);--> statement-breakpoint
CREATE INDEX `idx_tasks_parent_id` ON `tasks` (`parent_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_phase` ON `tasks` (`phase`);--> statement-breakpoint
CREATE INDEX `idx_tasks_type` ON `tasks` (`type`);--> statement-breakpoint
CREATE INDEX `idx_tasks_priority` ON `tasks` (`priority`);