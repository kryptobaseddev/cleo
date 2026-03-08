CREATE TABLE `token_usage` (
	`id` text PRIMARY KEY,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`provider` text DEFAULT 'unknown' NOT NULL,
	`model` text,
	`transport` text DEFAULT 'unknown' NOT NULL,
	`gateway` text,
	`domain` text,
	`operation` text,
	`session_id` text,
	`task_id` text,
	`request_id` text,
	`input_chars` integer DEFAULT 0 NOT NULL,
	`output_chars` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`method` text DEFAULT 'heuristic' NOT NULL,
	`confidence` text DEFAULT 'coarse' NOT NULL,
	`request_hash` text,
	`response_hash` text,
	`metadata_json` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_token_usage_created_at` ON `token_usage` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_token_usage_request_id` ON `token_usage` (`request_id`);--> statement-breakpoint
CREATE INDEX `idx_token_usage_session_id` ON `token_usage` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_token_usage_task_id` ON `token_usage` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_token_usage_provider` ON `token_usage` (`provider`);--> statement-breakpoint
CREATE INDEX `idx_token_usage_transport` ON `token_usage` (`transport`);--> statement-breakpoint
CREATE INDEX `idx_token_usage_domain_operation` ON `token_usage` (`domain`,`operation`);--> statement-breakpoint
CREATE INDEX `idx_token_usage_method` ON `token_usage` (`method`);