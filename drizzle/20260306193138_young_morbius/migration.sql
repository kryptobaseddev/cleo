CREATE TABLE `pipeline_manifest` (
	`id` text PRIMARY KEY,
	`session_id` text,
	`task_id` text,
	`epic_id` text,
	`type` text NOT NULL,
	`content` text NOT NULL,
	`content_hash` text,
	`status` text DEFAULT 'active' NOT NULL,
	`distilled` integer DEFAULT false NOT NULL,
	`brain_obs_id` text,
	`source_file` text,
	`metadata_json` text,
	`created_at` text NOT NULL,
	`archived_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_pipeline_manifest_task_id` ON `pipeline_manifest` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_pipeline_manifest_session_id` ON `pipeline_manifest` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_pipeline_manifest_distilled` ON `pipeline_manifest` (`distilled`);--> statement-breakpoint
CREATE INDEX `idx_pipeline_manifest_status` ON `pipeline_manifest` (`status`);--> statement-breakpoint
CREATE INDEX `idx_pipeline_manifest_content_hash` ON `pipeline_manifest` (`content_hash`);