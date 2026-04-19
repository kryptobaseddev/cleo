-- T944 — additive role/scope/severity axes + experiments side-table
-- Orthogonal to existing `type` column. `type` is NOT deprecated; it remains
-- the hierarchical discriminator (epic/task/subtask). `role`, `scope`, and
-- `severity` are the new orthogonal axes for intent, granularity, and bug
-- priority respectively. See ADR / RCASD Round 2 for rationale.

ALTER TABLE `tasks` ADD COLUMN `role` TEXT NOT NULL DEFAULT 'work'
  CHECK (role IN ('work','research','experiment','bug','spike','release'));--> statement-breakpoint
ALTER TABLE `tasks` ADD COLUMN `scope` TEXT NOT NULL DEFAULT 'feature'
  CHECK (scope IN ('project','feature','unit'));--> statement-breakpoint
ALTER TABLE `tasks` ADD COLUMN `severity` TEXT
  CHECK (severity IS NULL OR (severity IN ('P0','P1','P2','P3') AND role='bug'));--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_tasks_role` ON `tasks` (`role`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tasks_scope` ON `tasks` (`scope`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tasks_role_status` ON `tasks` (`role`,`status`);--> statement-breakpoint

-- Backfill role/scope from legacy `type` so the 948 production rows land on
-- sensible non-default values. Rows with type=NULL are treated as 'task'.
UPDATE `tasks` SET `scope` = 'project' WHERE `type` = 'epic';--> statement-breakpoint
UPDATE `tasks` SET `scope` = 'feature' WHERE `type` = 'task' OR `type` IS NULL;--> statement-breakpoint
UPDATE `tasks` SET `scope` = 'unit' WHERE `type` = 'subtask';--> statement-breakpoint

-- Experiments side-table keyed 1:1 to tasks.id for role='experiment' rows.
CREATE TABLE IF NOT EXISTS `experiments` (
  `task_id` TEXT PRIMARY KEY REFERENCES `tasks`(`id`) ON DELETE CASCADE,
  `sandbox_branch` TEXT,
  `baseline_commit` TEXT,
  `merged_at` TEXT,
  `receipt_id` TEXT,
  `metrics_delta_json` TEXT,
  `created_at` TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_experiments_merged` ON `experiments` (`merged_at`);
