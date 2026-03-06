CREATE TABLE `nexus_audit_log` (
	`id` text PRIMARY KEY,
	`timestamp` text DEFAULT (datetime('now')) NOT NULL,
	`action` text NOT NULL,
	`project_hash` text,
	`project_id` text,
	`domain` text,
	`operation` text,
	`session_id` text,
	`request_id` text,
	`source` text,
	`gateway` text,
	`success` integer,
	`duration_ms` integer,
	`details_json` text DEFAULT '{}',
	`error_message` text
);
--> statement-breakpoint
CREATE TABLE `nexus_schema_meta` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `project_registry` (
	`project_id` text PRIMARY KEY,
	`project_hash` text NOT NULL,
	`project_path` text NOT NULL UNIQUE,
	`name` text NOT NULL,
	`registered_at` text DEFAULT (datetime('now')) NOT NULL,
	`last_seen` text DEFAULT (datetime('now')) NOT NULL,
	`health_status` text DEFAULT 'unknown' NOT NULL,
	`health_last_check` text,
	`permissions` text DEFAULT 'read' NOT NULL,
	`last_sync` text DEFAULT (datetime('now')) NOT NULL,
	`task_count` integer DEFAULT 0 NOT NULL,
	`labels_json` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_nexus_audit_timestamp` ON `nexus_audit_log` (`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_nexus_audit_action` ON `nexus_audit_log` (`action`);--> statement-breakpoint
CREATE INDEX `idx_nexus_audit_project_hash` ON `nexus_audit_log` (`project_hash`);--> statement-breakpoint
CREATE INDEX `idx_nexus_audit_project_id` ON `nexus_audit_log` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_nexus_audit_session` ON `nexus_audit_log` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_project_registry_hash` ON `project_registry` (`project_hash`);--> statement-breakpoint
CREATE INDEX `idx_project_registry_health` ON `project_registry` (`health_status`);--> statement-breakpoint
CREATE INDEX `idx_project_registry_name` ON `project_registry` (`name`);