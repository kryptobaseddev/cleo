-- T11522 (E6-L2): Add brain_task_observations to the consolidated cleo-project schema.
--
-- brain_task_observations is the join table linking brain_observations to task IDs
-- (T1615). It enables `cleo memory find` queries to surface session context for a
-- given task. It was created ONLY by a post-hoc `CREATE TABLE IF NOT EXISTS` in
-- memory-sqlite.ts::runBrainMigrations — it has NO drizzle-brain migration and was
-- NOT included in the T11363 consolidation migration (exodus maps it to `null` as a
-- runtime-only cache, see store/exodus/table-name-map.ts).
--
-- E6-L2 routes getBrainDb() through openDualScopeDb('project'), so the brain handle
-- now opens the consolidated project `cleo.db`. The runtime writer
-- (sessions/session-memory-bridge.ts) INSERTs into `brain_task_observations`, so the
-- table must exist in `cleo.db`. This forward migration replaces the removed post-hoc
-- DDL — matching the T9179 precedent (ensureColumns → forward Drizzle migration).
--
-- Schema matches the removed memory-sqlite.ts DDL exactly so the runtime writer
-- INSERTs without changes. All statements are IF NOT EXISTS so re-running is safe.
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
