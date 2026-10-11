-- T12896 — brain_task_observations joins the consolidated project schema.
--
-- The table (T1615, the observation/task join `cleo memory find` reads) was
-- created only by the standalone drizzle-brain migration
-- 20260601000001_t11522-brain-task-observations, which the consolidated store's
-- brain reconcile runs AFTER the open-time row-identity heal. A fresh store
-- therefore lacked it during the heal, so it could not be declared in
-- ROW_IDENTITY. This migration creates it with the same shape (every statement
-- IF NOT EXISTS, so a store the reconcile already gave the table keeps its rows
-- and the reconcile stays a no-op) and adds its row uid column and unique uid
-- index (natural identity on observation id + task uid, store/row-identity-registry.ts).
--
-- The uid column is ADD COLUMN (not part of the CREATE) so a store whose table
-- predates this migration gains it the same way a fresh one does; the column is
-- filled by TypeScript at open and by the per-connection TEMP trigger. No row is
-- touched here, so the gate 36 DML rules do not apply.
--
-- @task T12896
-- @epic T12323

CREATE TABLE IF NOT EXISTS `brain_task_observations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`observation_id` text NOT NULL,
	`task_id` text NOT NULL,
	`link_type` text DEFAULT 'session-completed' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_brain_task_obs_unique` ON `brain_task_observations` (`observation_id`, `task_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_task_obs_observation` ON `brain_task_observations` (`observation_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_task_obs_task` ON `brain_task_observations` (`task_id`);
--> statement-breakpoint
ALTER TABLE `brain_task_observations` ADD COLUMN `uid` text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_brain_task_observations_uid` ON `brain_task_observations` (`uid`);
