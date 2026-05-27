CREATE TABLE IF NOT EXISTS `brain_decisions` (
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
CREATE TABLE IF NOT EXISTS `brain_learnings` (
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
CREATE TABLE IF NOT EXISTS `brain_memory_links` (
	`memory_type` text NOT NULL,
	`memory_id` text NOT NULL,
	`task_id` text NOT NULL,
	`link_type` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `brain_memory_links_pk` PRIMARY KEY(`memory_type`, `memory_id`, `task_id`, `link_type`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `brain_observations` (
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
	`content_hash` text,
	`discovery_tokens` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `brain_page_edges` (
	`from_id` text NOT NULL,
	`to_id` text NOT NULL,
	`edge_type` text NOT NULL,
	`weight` real DEFAULT 1,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `brain_page_edges_pk` PRIMARY KEY(`from_id`, `to_id`, `edge_type`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `brain_page_nodes` (
	`id` text PRIMARY KEY,
	`node_type` text NOT NULL,
	`label` text NOT NULL,
	`metadata_json` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `brain_patterns` (
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
CREATE TABLE IF NOT EXISTS `brain_schema_meta` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `brain_sticky_notes` (
	`id` text PRIMARY KEY,
	`content` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text,
	`tags_json` text,
	`status` text DEFAULT 'active' NOT NULL,
	`converted_to_json` text,
	`color` text,
	`priority` text,
	`source_type` text DEFAULT 'sticky-note'
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_decisions_type` ON `brain_decisions` (`type`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_decisions_confidence` ON `brain_decisions` (`confidence`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_decisions_outcome` ON `brain_decisions` (`outcome`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_decisions_context_epic` ON `brain_decisions` (`context_epic_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_decisions_context_task` ON `brain_decisions` (`context_task_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_learnings_confidence` ON `brain_learnings` (`confidence`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_learnings_actionable` ON `brain_learnings` (`actionable`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_links_task` ON `brain_memory_links` (`task_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_links_memory` ON `brain_memory_links` (`memory_type`,`memory_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_observations_type` ON `brain_observations` (`type`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_observations_project` ON `brain_observations` (`project`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_observations_created_at` ON `brain_observations` (`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_observations_source_type` ON `brain_observations` (`source_type`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_observations_source_session` ON `brain_observations` (`source_session_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_observations_content_hash` ON `brain_observations` (`content_hash`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_edges_from` ON `brain_page_edges` (`from_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_edges_to` ON `brain_page_edges` (`to_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_nodes_type` ON `brain_page_nodes` (`node_type`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_patterns_type` ON `brain_patterns` (`type`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_patterns_impact` ON `brain_patterns` (`impact`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_patterns_frequency` ON `brain_patterns` (`frequency`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_sticky_status` ON `brain_sticky_notes` (`status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_sticky_created` ON `brain_sticky_notes` (`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_sticky_tags` ON `brain_sticky_notes` (`tags_json`);