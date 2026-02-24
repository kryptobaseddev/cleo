CREATE TABLE `lifecycle_evidence` (
	`id` text PRIMARY KEY,
	`stage_id` text NOT NULL,
	`uri` text NOT NULL,
	`type` text NOT NULL,
	`recorded_at` text DEFAULT (datetime('now')) NOT NULL,
	`recorded_by` text,
	`description` text,
	CONSTRAINT `fk_lifecycle_evidence_stage_id_lifecycle_stages_id_fk` FOREIGN KEY (`stage_id`) REFERENCES `lifecycle_stages`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `lifecycle_gate_results` (
	`id` text PRIMARY KEY,
	`stage_id` text NOT NULL,
	`gate_name` text NOT NULL,
	`result` text NOT NULL,
	`checked_at` text DEFAULT (datetime('now')) NOT NULL,
	`checked_by` text NOT NULL,
	`details` text,
	`reason` text,
	CONSTRAINT `fk_lifecycle_gate_results_stage_id_lifecycle_stages_id_fk` FOREIGN KEY (`stage_id`) REFERENCES `lifecycle_stages`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `lifecycle_pipelines` (
	`id` text PRIMARY KEY,
	`task_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`current_stage_id` text,
	`started_at` text DEFAULT (datetime('now')) NOT NULL,
	`completed_at` text,
	CONSTRAINT `fk_lifecycle_pipelines_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `lifecycle_stages` (
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
	CONSTRAINT `fk_lifecycle_stages_pipeline_id_lifecycle_pipelines_id_fk` FOREIGN KEY (`pipeline_id`) REFERENCES `lifecycle_pipelines`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `lifecycle_transitions` (
	`id` text PRIMARY KEY,
	`pipeline_id` text NOT NULL,
	`from_stage_id` text NOT NULL,
	`to_stage_id` text NOT NULL,
	`transition_type` text DEFAULT 'automatic' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `fk_lifecycle_transitions_pipeline_id_lifecycle_pipelines_id_fk` FOREIGN KEY (`pipeline_id`) REFERENCES `lifecycle_pipelines`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `schema_meta` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
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
	`ended_at` text
);
--> statement-breakpoint
CREATE TABLE `task_dependencies` (
	`task_id` text NOT NULL,
	`depends_on` text NOT NULL,
	CONSTRAINT `task_dependencies_pk` PRIMARY KEY(`task_id`, `depends_on`),
	CONSTRAINT `fk_task_dependencies_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_task_dependencies_depends_on_tasks_id_fk` FOREIGN KEY (`depends_on`) REFERENCES `tasks`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `task_relations` (
	`task_id` text NOT NULL,
	`related_to` text NOT NULL,
	`relation_type` text DEFAULT 'related' NOT NULL,
	CONSTRAINT `task_relations_pk` PRIMARY KEY(`task_id`, `related_to`),
	CONSTRAINT `fk_task_relations_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_task_relations_related_to_tasks_id_fk` FOREIGN KEY (`related_to`) REFERENCES `tasks`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `task_work_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`session_id` text NOT NULL,
	`task_id` text NOT NULL,
	`set_at` text DEFAULT (datetime('now')) NOT NULL,
	`cleared_at` text,
	CONSTRAINT `fk_task_work_history_session_id_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `tasks` (
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
	`session_id` text
);
--> statement-breakpoint
CREATE INDEX `idx_lifecycle_evidence_stage_id` ON `lifecycle_evidence` (`stage_id`);--> statement-breakpoint
CREATE INDEX `idx_lifecycle_gate_results_stage_id` ON `lifecycle_gate_results` (`stage_id`);--> statement-breakpoint
CREATE INDEX `idx_lifecycle_pipelines_task_id` ON `lifecycle_pipelines` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_lifecycle_pipelines_status` ON `lifecycle_pipelines` (`status`);--> statement-breakpoint
CREATE INDEX `idx_lifecycle_stages_pipeline_id` ON `lifecycle_stages` (`pipeline_id`);--> statement-breakpoint
CREATE INDEX `idx_lifecycle_stages_stage_name` ON `lifecycle_stages` (`stage_name`);--> statement-breakpoint
CREATE INDEX `idx_lifecycle_stages_status` ON `lifecycle_stages` (`status`);--> statement-breakpoint
CREATE INDEX `idx_lifecycle_transitions_pipeline_id` ON `lifecycle_transitions` (`pipeline_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_status` ON `sessions` (`status`);--> statement-breakpoint
CREATE INDEX `idx_deps_depends_on` ON `task_dependencies` (`depends_on`);--> statement-breakpoint
CREATE INDEX `idx_work_history_session` ON `task_work_history` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_status` ON `tasks` (`status`);--> statement-breakpoint
CREATE INDEX `idx_tasks_parent_id` ON `tasks` (`parent_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_phase` ON `tasks` (`phase`);--> statement-breakpoint
CREATE INDEX `idx_tasks_type` ON `tasks` (`type`);--> statement-breakpoint
CREATE INDEX `idx_tasks_priority` ON `tasks` (`priority`);