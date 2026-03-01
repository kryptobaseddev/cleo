CREATE TABLE `brain_decisions` (
	`id` text PRIMARY KEY,
	`type` text NOT NULL,
	`decision` text NOT NULL,
	`rationale` text NOT NULL,
	`confidence` text NOT NULL,
	`outcome` text,
	`alternatives_json` text,
	`context_epic_id` text,
	`context_task_id` text,
	`context_phase` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text
);
--> statement-breakpoint
CREATE TABLE `brain_learnings` (
	`id` text PRIMARY KEY,
	`insight` text NOT NULL,
	`source` text NOT NULL,
	`confidence` real NOT NULL,
	`actionable` integer DEFAULT false NOT NULL,
	`application` text,
	`applicable_types_json` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text
);
--> statement-breakpoint
CREATE TABLE `brain_memory_links` (
	`memory_type` text NOT NULL,
	`memory_id` text NOT NULL,
	`task_id` text NOT NULL,
	`link_type` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `brain_memory_links_pk` PRIMARY KEY(`memory_type`, `memory_id`, `task_id`, `link_type`)
);
--> statement-breakpoint
CREATE TABLE `brain_patterns` (
	`id` text PRIMARY KEY,
	`type` text NOT NULL,
	`pattern` text NOT NULL,
	`context` text NOT NULL,
	`frequency` integer DEFAULT 1 NOT NULL,
	`success_rate` real,
	`impact` text,
	`anti_pattern` text,
	`mitigation` text,
	`examples_json` text DEFAULT '[]',
	`extracted_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text
);
--> statement-breakpoint
CREATE TABLE `brain_schema_meta` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_brain_decisions_type` ON `brain_decisions` (`type`);--> statement-breakpoint
CREATE INDEX `idx_brain_decisions_confidence` ON `brain_decisions` (`confidence`);--> statement-breakpoint
CREATE INDEX `idx_brain_decisions_outcome` ON `brain_decisions` (`outcome`);--> statement-breakpoint
CREATE INDEX `idx_brain_decisions_context_epic` ON `brain_decisions` (`context_epic_id`);--> statement-breakpoint
CREATE INDEX `idx_brain_decisions_context_task` ON `brain_decisions` (`context_task_id`);--> statement-breakpoint
CREATE INDEX `idx_brain_learnings_confidence` ON `brain_learnings` (`confidence`);--> statement-breakpoint
CREATE INDEX `idx_brain_learnings_actionable` ON `brain_learnings` (`actionable`);--> statement-breakpoint
CREATE INDEX `idx_brain_links_task` ON `brain_memory_links` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_brain_links_memory` ON `brain_memory_links` (`memory_type`,`memory_id`);--> statement-breakpoint
CREATE INDEX `idx_brain_patterns_type` ON `brain_patterns` (`type`);--> statement-breakpoint
CREATE INDEX `idx_brain_patterns_impact` ON `brain_patterns` (`impact`);--> statement-breakpoint
CREATE INDEX `idx_brain_patterns_frequency` ON `brain_patterns` (`frequency`);