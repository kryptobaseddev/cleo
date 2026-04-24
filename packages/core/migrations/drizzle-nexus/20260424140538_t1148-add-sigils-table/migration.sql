CREATE TABLE `sigils` (
	`peer_id` text PRIMARY KEY,
	`cant_file` text,
	`display_name` text DEFAULT '' NOT NULL,
	`role` text DEFAULT '' NOT NULL,
	`system_prompt_fragment` text,
	`capability_flags` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sigils_display_name` ON `sigils` (`display_name`);--> statement-breakpoint
CREATE INDEX `idx_sigils_role` ON `sigils` (`role`);