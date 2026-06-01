-- T11546: Add brain_usage_log table to consolidated cleo-project schema.
--
-- brain_usage_log is the quality-feedback telemetry table (8471 rows in live
-- brain.db). It was not included in the T11363 consolidation migration because
-- it is created by quality-feedback.ts via CREATE TABLE IF NOT EXISTS (not
-- Drizzle-managed). Adding it here makes exodus migration populate it correctly.
--
-- Schema matches quality-feedback.ts ensureUsageLogTable() exactly so the
-- runtime writer can INSERT against this table without changes.
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
