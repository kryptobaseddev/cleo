CREATE TABLE `brain_observations` (
	`id` text PRIMARY KEY,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`subtitle` text,
	`narrative` text,
	`facts_json` text,
	`concepts_json` text,
	`project` text,
	`files_read_json` text,
	`files_modified_json` text,
	`source_session_id` text,
	`source_type` text DEFAULT 'agent' NOT NULL,
	`discovery_tokens` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_brain_observations_type` ON `brain_observations` (`type`);--> statement-breakpoint
CREATE INDEX `idx_brain_observations_project` ON `brain_observations` (`project`);--> statement-breakpoint
CREATE INDEX `idx_brain_observations_created_at` ON `brain_observations` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_brain_observations_source_type` ON `brain_observations` (`source_type`);--> statement-breakpoint
CREATE INDEX `idx_brain_observations_source_session` ON `brain_observations` (`source_session_id`);