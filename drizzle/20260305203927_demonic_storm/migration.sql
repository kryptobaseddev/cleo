CREATE TABLE `warp_chain_instances` (
	`id` text PRIMARY KEY,
	`chain_id` text NOT NULL,
	`epic_id` text NOT NULL,
	`variables` text,
	`stage_to_task` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`current_stage` text,
	`gate_results` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE TABLE `warp_chains` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`version` text NOT NULL,
	`description` text,
	`definition` text NOT NULL,
	`validated` integer DEFAULT false,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX `idx_warp_instances_chain` ON `warp_chain_instances` (`chain_id`);--> statement-breakpoint
CREATE INDEX `idx_warp_instances_epic` ON `warp_chain_instances` (`epic_id`);--> statement-breakpoint
CREATE INDEX `idx_warp_instances_status` ON `warp_chain_instances` (`status`);--> statement-breakpoint
CREATE INDEX `idx_warp_chains_name` ON `warp_chains` (`name`);