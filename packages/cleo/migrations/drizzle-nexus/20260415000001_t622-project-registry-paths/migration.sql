-- T622: Multi-Project Registry — add brain_db_path, tasks_db_path, last_indexed, stats_json
-- to project_registry so Studio can switch between project contexts and display per-project stats.

ALTER TABLE `project_registry` ADD COLUMN `brain_db_path` text;
--> statement-breakpoint
ALTER TABLE `project_registry` ADD COLUMN `tasks_db_path` text;
--> statement-breakpoint
ALTER TABLE `project_registry` ADD COLUMN `last_indexed` text;
--> statement-breakpoint
ALTER TABLE `project_registry` ADD COLUMN `stats_json` text DEFAULT '{}' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_project_registry_last_indexed` ON `project_registry` (`last_indexed`);
