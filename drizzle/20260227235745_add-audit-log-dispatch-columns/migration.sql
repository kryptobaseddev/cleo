-- Add dispatch layer columns to audit_log table.
-- These columns were added to schema.ts but the migration that creates them
-- (referenced as 20260225200000) was never committed to the migrations folder.
-- Without these columns, any INSERT via drizzle fails on fresh databases because
-- drizzle generates SQL referencing all 17 schema columns but the table only has 8.
-- This fixes the core-parity.test.ts taskCreate test failure.
--
-- Uses table rebuild pattern (not ALTER TABLE ADD) so it works on both:
--   1. Fresh databases where audit_log has only 8 base columns
--   2. Existing databases where columns were already added out-of-band
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_audit_log` (
	`id` text PRIMARY KEY,
	`timestamp` text DEFAULT (datetime('now')) NOT NULL,
	`action` text NOT NULL,
	`task_id` text NOT NULL,
	`actor` text DEFAULT 'system' NOT NULL,
	`details_json` text DEFAULT '{}',
	`before_json` text,
	`after_json` text,
	`domain` text,
	`operation` text,
	`session_id` text,
	`request_id` text,
	`duration_ms` integer,
	`success` integer,
	`source` text,
	`gateway` text,
	`error_message` text
);--> statement-breakpoint
INSERT INTO `__new_audit_log` (`id`, `timestamp`, `action`, `task_id`, `actor`, `details_json`, `before_json`, `after_json`)
  SELECT `id`, `timestamp`, `action`, `task_id`, `actor`, `details_json`, `before_json`, `after_json` FROM `audit_log`;--> statement-breakpoint
DROP TABLE `audit_log`;--> statement-breakpoint
ALTER TABLE `__new_audit_log` RENAME TO `audit_log`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_audit_log_task_id` ON `audit_log` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_audit_log_action` ON `audit_log` (`action`);--> statement-breakpoint
CREATE INDEX `idx_audit_log_timestamp` ON `audit_log` (`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_audit_log_domain` ON `audit_log` (`domain`);--> statement-breakpoint
CREATE INDEX `idx_audit_log_request_id` ON `audit_log` (`request_id`);
