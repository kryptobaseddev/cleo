CREATE TABLE IF NOT EXISTS `skills` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`version` text,
	`source_type` text NOT NULL,
	`source_url` text,
	`install_path` text NOT NULL,
	`canonical_path` text,
	`installed_at` text NOT NULL,
	`last_updated_at` text,
	`lifecycle_state` text DEFAULT 'active' NOT NULL,
	`pinned` integer DEFAULT 0 NOT NULL,
	`is_agent_created` integer DEFAULT 0 NOT NULL,
	`archived_at` text,
	`archived_from_path` text,
	CONSTRAINT `skills_source_type_check` CHECK (`source_type` IN ('canonical','user','community','agent-created')),
	CONSTRAINT `skills_lifecycle_state_check` CHECK (`lifecycle_state` IN ('active','stale','archived'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `skills_name_unique` ON `skills` (`name`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_skills_state` ON `skills` (`lifecycle_state`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_skills_source` ON `skills` (`source_type`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `skill_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`skill_name` text NOT NULL,
	`observed_at` text DEFAULT (datetime('now')) NOT NULL,
	`event_kind` text NOT NULL,
	`task_id` text,
	`model_id` text,
	`metadata` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_skill_usage_name_observed` ON `skill_usage` (`skill_name`,`observed_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_skill_usage_kind` ON `skill_usage` (`event_kind`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `skill_reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`skill_name` text NOT NULL,
	`reviewed_at` text DEFAULT (datetime('now')) NOT NULL,
	`outcome` text NOT NULL,
	`score` integer,
	`review_run_id` text,
	`summary` text,
	CONSTRAINT `skill_reviews_outcome_check` CHECK (`outcome` IN ('approved','rejected','needs-changes'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_skill_reviews_name_reviewed` ON `skill_reviews` (`skill_name`,`reviewed_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_skill_reviews_outcome` ON `skill_reviews` (`outcome`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `skill_patches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`skill_name` text NOT NULL,
	`proposed_at` text DEFAULT (datetime('now')) NOT NULL,
	`applied_at` text,
	`review_id` integer,
	`diff` text NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`reverted_by_patch_id` integer,
	CONSTRAINT `skill_patches_status_check` CHECK (`status` IN ('proposed','applied','reverted','rejected'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_skill_patches_name_proposed` ON `skill_patches` (`skill_name`,`proposed_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_skill_patches_status` ON `skill_patches` (`status`);
