CREATE TABLE IF NOT EXISTS `agent_instances` (
	`id` text PRIMARY KEY,
	`agent_type` text NOT NULL,
	`status` text DEFAULT 'starting' NOT NULL,
	`session_id` text,
	`task_id` text,
	`started_at` text DEFAULT (datetime('now')) NOT NULL,
	`last_heartbeat` text DEFAULT (datetime('now')) NOT NULL,
	`stopped_at` text,
	`error_count` integer DEFAULT 0 NOT NULL,
	`total_tasks_completed` integer DEFAULT 0 NOT NULL,
	`capacity` text DEFAULT '1.0' NOT NULL,
	`metadata_json` text DEFAULT '{}',
	`parent_agent_id` text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `agent_error_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`agent_id` text NOT NULL,
	`error_type` text NOT NULL,
	`message` text NOT NULL,
	`stack` text,
	`occurred_at` text DEFAULT (datetime('now')) NOT NULL,
	`resolved` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agent_instances_status` ON `agent_instances` (`status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agent_instances_agent_type` ON `agent_instances` (`agent_type`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agent_instances_session_id` ON `agent_instances` (`session_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agent_instances_task_id` ON `agent_instances` (`task_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agent_instances_parent_agent_id` ON `agent_instances` (`parent_agent_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agent_instances_last_heartbeat` ON `agent_instances` (`last_heartbeat`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agent_error_log_agent_id` ON `agent_error_log` (`agent_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agent_error_log_error_type` ON `agent_error_log` (`error_type`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agent_error_log_occurred_at` ON `agent_error_log` (`occurred_at`);
