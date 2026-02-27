-- Add 'cancelled' to lifecycle_pipelines.status CHECK constraint.
-- Semantic distinction from 'aborted':
--   cancelled = user-initiated abandonment (deliberate decision to stop)
--   aborted   = system-forced termination (error recovery, crash)
-- Mirrors LIFECYCLE_PIPELINE_STATUSES in src/store/status-registry.ts.
--
-- SQLite does not support ALTER TABLE ... MODIFY COLUMN. Table rebuild required.
-- drizzle-kit v7 snapshots do not capture CHECK constraint enum values, so this
-- change is invisible to drizzle-kit generate. Use --custom for cases like this.

PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_lifecycle_pipelines` (
	`id` text PRIMARY KEY,
	`task_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`current_stage_id` text,
	`started_at` text DEFAULT (datetime('now')) NOT NULL,
	`completed_at` text,
	CONSTRAINT `fk_lifecycle_pipelines_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE,
	CONSTRAINT "chk_lifecycle_pipelines_status" CHECK("status" IN ('active','completed','blocked','failed','cancelled','aborted'))
);--> statement-breakpoint
INSERT INTO `__new_lifecycle_pipelines` SELECT * FROM `lifecycle_pipelines`;--> statement-breakpoint
DROP TABLE `lifecycle_pipelines`;--> statement-breakpoint
ALTER TABLE `__new_lifecycle_pipelines` RENAME TO `lifecycle_pipelines`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_lifecycle_pipelines_task_id` ON `lifecycle_pipelines` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_lifecycle_pipelines_status` ON `lifecycle_pipelines` (`status`);--> statement-breakpoint
INSERT OR IGNORE INTO `status_registry` VALUES ('cancelled', 'lifecycle_pipeline', 'workflow', 'Abandoned pipeline; will not be completed (user-initiated)', 1);
