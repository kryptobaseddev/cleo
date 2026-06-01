-- T11546: Add brain_usage_log table to consolidated cleo-global schema.
--
-- brain_usage_log is mirrored across both project and global scopes (it is a
-- brain-domain table). See drizzle-cleo-project version for full rationale.
CREATE TABLE IF NOT EXISTS `brain_usage_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entry_id` text NOT NULL,
	`task_id` text,
	`used` integer DEFAULT 0 NOT NULL,
	`outcome` text DEFAULT 'unknown' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_usage_log_entry_id` ON `brain_usage_log` (`entry_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_usage_log_task_id` ON `brain_usage_log` (`task_id`);
