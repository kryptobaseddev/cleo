CREATE TABLE `attachment_refs` (
	`attachment_id` text NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`attached_at` text NOT NULL,
	`attached_by` text,
	CONSTRAINT `attachment_refs_pk` PRIMARY KEY(`attachment_id`, `owner_type`, `owner_id`)
);
--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text PRIMARY KEY,
	`sha256` text NOT NULL,
	`attachment_json` text NOT NULL,
	`created_at` text NOT NULL,
	`ref_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `experiments` (
	`task_id` text PRIMARY KEY,
	`sandbox_branch` text,
	`baseline_commit` text,
	`merged_at` text,
	`receipt_id` text,
	`metrics_delta_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_experiments_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `tasks` ADD `role` text DEFAULT 'work' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `scope` text DEFAULT 'feature' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `severity` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `ivtr_state` text;--> statement-breakpoint
CREATE INDEX `idx_attachment_refs_attachment_id` ON `attachment_refs` (`attachment_id`);--> statement-breakpoint
CREATE INDEX `idx_attachment_refs_owner` ON `attachment_refs` (`owner_type`,`owner_id`);--> statement-breakpoint
CREATE INDEX `idx_attachments_sha256` ON `attachments` (`sha256`);--> statement-breakpoint
CREATE INDEX `idx_experiments_merged` ON `experiments` (`merged_at`);--> statement-breakpoint
CREATE INDEX `idx_tasks_role` ON `tasks` (`role`);--> statement-breakpoint
CREATE INDEX `idx_tasks_scope` ON `tasks` (`scope`);--> statement-breakpoint
CREATE INDEX `idx_tasks_role_status` ON `tasks` (`role`,`status`);