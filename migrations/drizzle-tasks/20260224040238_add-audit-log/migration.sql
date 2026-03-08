CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY,
	`timestamp` text DEFAULT (datetime('now')) NOT NULL,
	`action` text NOT NULL,
	`task_id` text NOT NULL,
	`actor` text DEFAULT 'system' NOT NULL,
	`details_json` text DEFAULT '{}',
	`before_json` text,
	`after_json` text
);
--> statement-breakpoint
CREATE INDEX `idx_audit_log_task_id` ON `audit_log` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_audit_log_action` ON `audit_log` (`action`);--> statement-breakpoint
CREATE INDEX `idx_audit_log_timestamp` ON `audit_log` (`timestamp`);