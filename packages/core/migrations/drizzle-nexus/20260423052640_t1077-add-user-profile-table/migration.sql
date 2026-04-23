CREATE TABLE `user_profile` (
	`trait_key` text PRIMARY KEY,
	`trait_value` text NOT NULL,
	`confidence` real NOT NULL,
	`source` text NOT NULL,
	`derived_from_message_id` text,
	`first_observed_at` integer NOT NULL,
	`last_reinforced_at` integer NOT NULL,
	`reinforcement_count` integer DEFAULT 1 NOT NULL,
	`superseded_by` text
);
--> statement-breakpoint
CREATE INDEX `idx_user_profile_confidence` ON `user_profile` (`confidence`);--> statement-breakpoint
CREATE INDEX `idx_user_profile_source` ON `user_profile` (`source`);--> statement-breakpoint
CREATE INDEX `idx_user_profile_last_reinforced` ON `user_profile` (`last_reinforced_at`);--> statement-breakpoint
CREATE INDEX `idx_user_profile_superseded` ON `user_profile` (`superseded_by`);