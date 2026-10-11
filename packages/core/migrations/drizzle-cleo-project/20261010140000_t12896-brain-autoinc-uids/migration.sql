-- T12896 (epic T12323) — row uids for the brain tables keyed by an INTEGER
-- AUTOINCREMENT id (project store).
--
-- Adds a nullable `uid` column, a `birth_fp` column and a unique index on
-- `uid` to the minted integer-keyed brain tables: retrieval log, plasticity
-- events, weight history, modulators, consolidation events and usage log. The
-- INTEGER id stays a LOCAL key (it numbers from 1 on every device): it never
-- travels, and a received row gets the next local id. Spec: `cleo docs fetch t12341-uid-scheme` (§4).
--
-- The columns are filled by TypeScript at open (store/row-identity.ts, inside
-- the cold-open lease), and rows inserted by this build get theirs from the
-- per-connection TEMP trigger. Nothing here rebuilds a table or touches a row
-- (only ADD COLUMN and CREATE INDEX), so the T12541 rebuild probe and the
-- gate 36 DML rules do not apply; a probe-stamped store gets its columns and
-- indexes from the open's heal.
--
-- `brain_task_observations` (natural on observation and task) is not in the
-- consolidated schema (the drizzle-brain reconcile creates it), so the open's
-- identity heal adds its column and index rather than this migration.
--
-- @task T12896
-- @epic T12323

ALTER TABLE `brain_retrieval_log` ADD COLUMN `uid` text;
--> statement-breakpoint
ALTER TABLE `brain_retrieval_log` ADD COLUMN `birth_fp` text;
--> statement-breakpoint
ALTER TABLE `brain_plasticity_events` ADD COLUMN `uid` text;
--> statement-breakpoint
ALTER TABLE `brain_plasticity_events` ADD COLUMN `birth_fp` text;
--> statement-breakpoint
ALTER TABLE `brain_weight_history` ADD COLUMN `uid` text;
--> statement-breakpoint
ALTER TABLE `brain_weight_history` ADD COLUMN `birth_fp` text;
--> statement-breakpoint
ALTER TABLE `brain_modulators` ADD COLUMN `uid` text;
--> statement-breakpoint
ALTER TABLE `brain_modulators` ADD COLUMN `birth_fp` text;
--> statement-breakpoint
ALTER TABLE `brain_consolidation_events` ADD COLUMN `uid` text;
--> statement-breakpoint
ALTER TABLE `brain_consolidation_events` ADD COLUMN `birth_fp` text;
--> statement-breakpoint
ALTER TABLE `brain_usage_log` ADD COLUMN `uid` text;
--> statement-breakpoint
ALTER TABLE `brain_usage_log` ADD COLUMN `birth_fp` text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_brain_retrieval_log_uid` ON `brain_retrieval_log` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_brain_plasticity_events_uid` ON `brain_plasticity_events` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_brain_weight_history_uid` ON `brain_weight_history` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_brain_modulators_uid` ON `brain_modulators` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_brain_consolidation_events_uid` ON `brain_consolidation_events` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_brain_usage_log_uid` ON `brain_usage_log` (`uid`);
