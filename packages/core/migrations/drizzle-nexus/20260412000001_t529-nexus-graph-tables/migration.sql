CREATE TABLE IF NOT EXISTS `nexus_nodes` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`name` text,
	`file_path` text,
	`start_line` integer,
	`end_line` integer,
	`language` text,
	`is_exported` integer DEFAULT false NOT NULL,
	`parent_id` text,
	`parameters_json` text,
	`return_type` text,
	`doc_summary` text,
	`community_id` text,
	`meta_json` text,
	`indexed_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `nexus_relations` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`source_id` text NOT NULL,
	`target_id` text NOT NULL,
	`type` text NOT NULL,
	`confidence` real NOT NULL,
	`reason` text,
	`step` integer,
	`indexed_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_nexus_nodes_project` ON `nexus_nodes` (`project_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_nexus_nodes_kind` ON `nexus_nodes` (`kind`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_nexus_nodes_file` ON `nexus_nodes` (`file_path`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_nexus_nodes_name` ON `nexus_nodes` (`name`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_nexus_nodes_project_kind` ON `nexus_nodes` (`project_id`,`kind`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_nexus_nodes_project_file` ON `nexus_nodes` (`project_id`,`file_path`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_nexus_nodes_community` ON `nexus_nodes` (`community_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_nexus_nodes_parent` ON `nexus_nodes` (`parent_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_nexus_nodes_exported` ON `nexus_nodes` (`is_exported`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_nexus_relations_project` ON `nexus_relations` (`project_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_nexus_relations_source` ON `nexus_relations` (`source_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_nexus_relations_target` ON `nexus_relations` (`target_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_nexus_relations_type` ON `nexus_relations` (`type`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_nexus_relations_project_type` ON `nexus_relations` (`project_id`,`type`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_nexus_relations_source_type` ON `nexus_relations` (`source_id`,`type`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_nexus_relations_target_type` ON `nexus_relations` (`target_id`,`type`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_nexus_relations_confidence` ON `nexus_relations` (`confidence`);
