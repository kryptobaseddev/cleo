CREATE TABLE `release_manifests` (
	`id` text PRIMARY KEY,
	`version` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`pipeline_id` text,
	`epic_id` text,
	`tasks_json` text DEFAULT '[]' NOT NULL,
	`changelog` text,
	`notes` text,
	`previous_version` text,
	`commit_sha` text,
	`git_tag` text,
	`npm_dist_tag` text,
	`created_at` text NOT NULL,
	`prepared_at` text,
	`committed_at` text,
	`tagged_at` text,
	`pushed_at` text,
	CONSTRAINT `fk_release_manifests_pipeline_id_lifecycle_pipelines_id_fk` FOREIGN KEY (`pipeline_id`) REFERENCES `lifecycle_pipelines`(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_release_manifests_status` ON `release_manifests` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_release_manifests_version` ON `release_manifests` (`version`);