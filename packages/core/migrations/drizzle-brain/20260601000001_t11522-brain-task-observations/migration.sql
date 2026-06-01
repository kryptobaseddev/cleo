-- T11522 (E6-L2): Add brain_task_observations as a forward Drizzle migration.
--
-- brain_task_observations (T1615) is the join table linking brain_observations to
-- task IDs; it powers `cleo memory find` session-context lookups. The runtime
-- writer is sessions/session-memory-bridge.ts.
--
-- It was previously created ONLY by a post-hoc `CREATE TABLE IF NOT EXISTS` in
-- memory-sqlite.ts::runBrainMigrations — it had NO Drizzle migration anywhere
-- (neither drizzle-brain nor the T11363 consolidation; exodus maps it to `null`
-- as a runtime-only cache). E6-L2 removes that inline band-aid and replaces it
-- with this forward migration, matching the T9179 precedent (ensureColumns /
-- self-healing DDL → forward Drizzle migration).
--
-- All statements are IF NOT EXISTS so re-running on a DB that already has the
-- table is idempotent and safe.
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
