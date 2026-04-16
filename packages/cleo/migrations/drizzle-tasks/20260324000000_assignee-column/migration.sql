-- B.1: Add assignee column to tasks table for agent task claiming.
-- Enables tasks.claim(taskId, agentId) and tasks.unclaim(taskId).
-- NULL = unclaimed; non-null = claimed by that agent ID.
ALTER TABLE `tasks` ADD COLUMN `assignee` text;
--> statement-breakpoint
CREATE INDEX `idx_tasks_assignee` ON `tasks` (`assignee`);
