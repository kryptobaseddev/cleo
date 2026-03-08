ALTER TABLE `sessions` ADD `previous_session_id` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `next_session_id` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `agent_identifier` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `handoff_consumed_at` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `handoff_consumed_by` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `debrief_json` text;--> statement-breakpoint
CREATE INDEX `idx_sessions_previous` ON `sessions` (`previous_session_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_agent_identifier` ON `sessions` (`agent_identifier`);