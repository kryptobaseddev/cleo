-- T11522 (E6-L2): Add the two runtime-legacy BRAIN tables the T11363 consolidation
-- migration skipped, so getBrainDb() — now routed through openDualScopeDb('project')
-- — can serve every brain-domain runtime query from the consolidated `cleo.db`.
--
-- Both tables were previously created by post-hoc `CREATE TABLE IF NOT EXISTS` DDL
-- in memory-sqlite.ts::runBrainMigrations, which E6-L2 removed. The runtime queries
-- them by their pre-consolidation physical names via raw SQL, so they must exist in
-- `cleo.db`. This forward migration replaces the removed post-hoc DDL — matching the
-- T9179 precedent (ensureColumns / self-healing DDL → forward Drizzle migration).
-- Running the legacy `drizzle-brain` migration set against the consolidated DB is NOT
-- viable: its cross-migration rename chain (t1147 `brain_v2_candidate` → t1402 RENAME
-- TO `brain_observations_staging`) collides with the final table the consolidation
-- already created. The consolidated schema is the brain SSoT; this migration adds only
-- the two genuinely-uncovered runtime tables.
--
-- 1. brain_task_observations (T1615) — join table linking brain_observations to task
--    IDs; powers `cleo memory find` session-context lookups. The runtime writer is
--    sessions/session-memory-bridge.ts. Exodus maps it to `null` (runtime-only cache).
--
-- 2. deriver_queue (T1145) — durable background derivation work queue. The runtime
--    accessors are packages/core/src/deriver/{enqueue,queue-manager,status}.ts, all of
--    which open via getBrainNativeDb() and query the UNPREFIXED name. The consolidated
--    schema carries the prefixed `brain_deriver_queue`; exodus renames the legacy table
--    onto it. Until that cutover the unprefixed table must exist for the runtime.
--
-- All statements are IF NOT EXISTS so re-running onto a DB that already has these
-- tables (e.g. after exodus) is idempotent and safe.
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
CREATE TABLE IF NOT EXISTS `deriver_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`item_type` text NOT NULL,
	`item_id` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`claimed_at` text,
	`claimed_by` text,
	`error_msg` text,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_deriver_queue_status_priority` ON `deriver_queue` (`status`, `priority` DESC, `created_at` ASC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_deriver_queue_item` ON `deriver_queue` (`item_type`, `item_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_deriver_queue_claimed_at` ON `deriver_queue` (`claimed_at`);
