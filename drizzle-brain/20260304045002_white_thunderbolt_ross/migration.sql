CREATE TABLE `brain_sticky_notes` (
	`id` text PRIMARY KEY,
	`content` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text,
	`tags_json` text,
	`status` text DEFAULT 'active' NOT NULL,
	`converted_to_json` text,
	`color` text,
	`priority` text,
	`source_type` text DEFAULT 'sticky-note'
);
--> statement-breakpoint
CREATE INDEX `idx_brain_sticky_status` ON `brain_sticky_notes` (`status`);--> statement-breakpoint
CREATE INDEX `idx_brain_sticky_created` ON `brain_sticky_notes` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_brain_sticky_tags` ON `brain_sticky_notes` (`tags_json`);