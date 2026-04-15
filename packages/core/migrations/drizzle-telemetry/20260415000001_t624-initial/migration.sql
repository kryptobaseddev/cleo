CREATE TABLE IF NOT EXISTS `telemetry_events` (
	`id` text PRIMARY KEY,
	`anonymous_id` text NOT NULL,
	`domain` text NOT NULL,
	`gateway` text NOT NULL,
	`operation` text NOT NULL,
	`command` text NOT NULL,
	`exit_code` integer NOT NULL DEFAULT 0,
	`duration_ms` integer NOT NULL,
	`error_code` text,
	`timestamp` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `telemetry_schema_meta` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_telemetry_command` ON `telemetry_events` (`command`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_telemetry_domain` ON `telemetry_events` (`domain`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_telemetry_exit_code` ON `telemetry_events` (`exit_code`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_telemetry_timestamp` ON `telemetry_events` (`timestamp`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_telemetry_duration` ON `telemetry_events` (`duration_ms`);
