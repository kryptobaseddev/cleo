CREATE TABLE `nexus_contracts` (
	`contract_id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`type` text NOT NULL,
	`path` text NOT NULL,
	`method` text,
	`request_schema_json` text DEFAULT '{}' NOT NULL,
	`response_schema_json` text DEFAULT '{}' NOT NULL,
	`source_symbol_id` text,
	`route_node_id` text,
	`confidence` real DEFAULT 1 NOT NULL,
	`description` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `nexus_nodes` (
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
	`is_external` integer DEFAULT false NOT NULL,
	`indexed_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `nexus_relations` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`source_id` text NOT NULL,
	`target_id` text NOT NULL,
	`type` text NOT NULL,
	`confidence` real NOT NULL,
	`reason` text,
	`step` integer,
	`indexed_at` text DEFAULT (datetime('now')) NOT NULL,
	`weight` real DEFAULT 0,
	`last_accessed_at` text,
	`co_accessed_count` integer DEFAULT 0
);
--> statement-breakpoint
ALTER TABLE `project_registry` ADD `brain_db_path` text;--> statement-breakpoint
ALTER TABLE `project_registry` ADD `tasks_db_path` text;--> statement-breakpoint
ALTER TABLE `project_registry` ADD `last_indexed` text;--> statement-breakpoint
ALTER TABLE `project_registry` ADD `stats_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_nexus_contracts_project` ON `nexus_contracts` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_nexus_contracts_type` ON `nexus_contracts` (`type`);--> statement-breakpoint
CREATE INDEX `idx_nexus_contracts_path` ON `nexus_contracts` (`path`);--> statement-breakpoint
CREATE INDEX `idx_nexus_contracts_method` ON `nexus_contracts` (`method`);--> statement-breakpoint
CREATE INDEX `idx_nexus_contracts_project_type` ON `nexus_contracts` (`project_id`,`type`);--> statement-breakpoint
CREATE INDEX `idx_nexus_contracts_source_symbol` ON `nexus_contracts` (`source_symbol_id`);--> statement-breakpoint
CREATE INDEX `idx_nexus_contracts_created` ON `nexus_contracts` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_nexus_nodes_project` ON `nexus_nodes` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_nexus_nodes_kind` ON `nexus_nodes` (`kind`);--> statement-breakpoint
CREATE INDEX `idx_nexus_nodes_file` ON `nexus_nodes` (`file_path`);--> statement-breakpoint
CREATE INDEX `idx_nexus_nodes_name` ON `nexus_nodes` (`name`);--> statement-breakpoint
CREATE INDEX `idx_nexus_nodes_project_kind` ON `nexus_nodes` (`project_id`,`kind`);--> statement-breakpoint
CREATE INDEX `idx_nexus_nodes_project_file` ON `nexus_nodes` (`project_id`,`file_path`);--> statement-breakpoint
CREATE INDEX `idx_nexus_nodes_community` ON `nexus_nodes` (`community_id`);--> statement-breakpoint
CREATE INDEX `idx_nexus_nodes_parent` ON `nexus_nodes` (`parent_id`);--> statement-breakpoint
CREATE INDEX `idx_nexus_nodes_exported` ON `nexus_nodes` (`is_exported`);--> statement-breakpoint
CREATE INDEX `idx_nexus_nodes_is_external` ON `nexus_nodes` (`is_external`);--> statement-breakpoint
CREATE INDEX `idx_nexus_relations_project` ON `nexus_relations` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_nexus_relations_source` ON `nexus_relations` (`source_id`);--> statement-breakpoint
CREATE INDEX `idx_nexus_relations_target` ON `nexus_relations` (`target_id`);--> statement-breakpoint
CREATE INDEX `idx_nexus_relations_type` ON `nexus_relations` (`type`);--> statement-breakpoint
CREATE INDEX `idx_nexus_relations_project_type` ON `nexus_relations` (`project_id`,`type`);--> statement-breakpoint
CREATE INDEX `idx_nexus_relations_source_type` ON `nexus_relations` (`source_id`,`type`);--> statement-breakpoint
CREATE INDEX `idx_nexus_relations_target_type` ON `nexus_relations` (`target_id`,`type`);--> statement-breakpoint
CREATE INDEX `idx_nexus_relations_confidence` ON `nexus_relations` (`confidence`);--> statement-breakpoint
CREATE INDEX `idx_nexus_relations_last_accessed` ON `nexus_relations` (`last_accessed_at`);--> statement-breakpoint
CREATE INDEX `idx_project_registry_last_indexed` ON `project_registry` (`last_indexed`);