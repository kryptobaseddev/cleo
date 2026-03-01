CREATE TABLE `manifest_entries` (
	`id` text PRIMARY KEY,
	`pipeline_id` text,
	`stage_id` text,
	`title` text NOT NULL,
	`date` text NOT NULL,
	`status` text NOT NULL,
	`agent_type` text,
	`output_file` text,
	`topics_json` text DEFAULT '[]',
	`findings_json` text DEFAULT '[]',
	`linked_tasks_json` text DEFAULT '[]',
	`created_by` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `fk_manifest_entries_pipeline_id_lifecycle_pipelines_id_fk` FOREIGN KEY (`pipeline_id`) REFERENCES `lifecycle_pipelines`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_manifest_entries_stage_id_lifecycle_stages_id_fk` FOREIGN KEY (`stage_id`) REFERENCES `lifecycle_stages`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `lifecycle_stages` ADD `output_file` text;--> statement-breakpoint
ALTER TABLE `lifecycle_stages` ADD `created_by` text;--> statement-breakpoint
ALTER TABLE `lifecycle_stages` ADD `validated_by` text;--> statement-breakpoint
ALTER TABLE `lifecycle_stages` ADD `validated_at` text;--> statement-breakpoint
ALTER TABLE `lifecycle_stages` ADD `validation_status` text;--> statement-breakpoint
ALTER TABLE `lifecycle_stages` ADD `provenance_chain_json` text;--> statement-breakpoint
CREATE INDEX `idx_manifest_entries_pipeline_id` ON `manifest_entries` (`pipeline_id`);--> statement-breakpoint
CREATE INDEX `idx_manifest_entries_stage_id` ON `manifest_entries` (`stage_id`);--> statement-breakpoint
CREATE INDEX `idx_manifest_entries_status` ON `manifest_entries` (`status`);