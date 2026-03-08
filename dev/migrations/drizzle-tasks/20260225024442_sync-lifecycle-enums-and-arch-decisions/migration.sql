CREATE TABLE `architecture_decisions` (
	`id` text PRIMARY KEY,
	`title` text NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`supersedes_id` text,
	`superseded_by_id` text,
	`consensus_manifest_id` text,
	`content` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text,
	CONSTRAINT `fk_architecture_decisions_supersedes_id_architecture_decisions_id_fk` FOREIGN KEY (`supersedes_id`) REFERENCES `architecture_decisions`(`id`),
	CONSTRAINT `fk_architecture_decisions_superseded_by_id_architecture_decisions_id_fk` FOREIGN KEY (`superseded_by_id`) REFERENCES `architecture_decisions`(`id`),
	CONSTRAINT "chk_arch_decisions_status" CHECK("status" IN ('proposed','accepted','superseded','deprecated'))
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_lifecycle_stages` (
	`id` text PRIMARY KEY,
	`pipeline_id` text NOT NULL,
	`stage_name` text NOT NULL,
	`status` text DEFAULT 'not_started' NOT NULL,
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
	CONSTRAINT "chk_lifecycle_stages_stage_name" CHECK("stage_name" IN ('research','consensus','architecture_decision','specification','decomposition','implementation','validation','testing','release','contribution')),
	CONSTRAINT "chk_lifecycle_stages_status" CHECK("status" IN ('not_started','in_progress','blocked','completed','skipped','failed'))
);
--> statement-breakpoint
INSERT INTO `__new_lifecycle_stages`(`id`, `pipeline_id`, `stage_name`, `status`, `sequence`, `started_at`, `completed_at`, `blocked_at`, `block_reason`, `skipped_at`, `skip_reason`, `notes_json`, `metadata_json`) SELECT `id`, `pipeline_id`, `stage_name`, CASE WHEN `status` = 'pending' THEN 'not_started' WHEN `status` = 'active' THEN 'in_progress' ELSE `status` END, `sequence`, `started_at`, `completed_at`, `blocked_at`, `block_reason`, `skipped_at`, `skip_reason`, `notes_json`, `metadata_json` FROM `lifecycle_stages`;--> statement-breakpoint
DROP TABLE `lifecycle_stages`;--> statement-breakpoint
ALTER TABLE `__new_lifecycle_stages` RENAME TO `lifecycle_stages`;--> statement-breakpoint
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
	CONSTRAINT "chk_lifecycle_pipelines_status" CHECK("status" IN ('active','completed','blocked','failed','aborted'))
);
--> statement-breakpoint
INSERT INTO `__new_lifecycle_pipelines`(`id`, `task_id`, `status`, `current_stage_id`, `started_at`, `completed_at`) SELECT `id`, `task_id`, `status`, `current_stage_id`, `started_at`, `completed_at` FROM `lifecycle_pipelines`;--> statement-breakpoint
DROP TABLE `lifecycle_pipelines`;--> statement-breakpoint
ALTER TABLE `__new_lifecycle_pipelines` RENAME TO `lifecycle_pipelines`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_lifecycle_stages_pipeline_id` ON `lifecycle_stages` (`pipeline_id`);--> statement-breakpoint
CREATE INDEX `idx_lifecycle_stages_stage_name` ON `lifecycle_stages` (`stage_name`);--> statement-breakpoint
CREATE INDEX `idx_lifecycle_stages_status` ON `lifecycle_stages` (`status`);--> statement-breakpoint
CREATE INDEX `idx_lifecycle_pipelines_task_id` ON `lifecycle_pipelines` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_lifecycle_pipelines_status` ON `lifecycle_pipelines` (`status`);--> statement-breakpoint
CREATE INDEX `idx_arch_decisions_status` ON `architecture_decisions` (`status`);