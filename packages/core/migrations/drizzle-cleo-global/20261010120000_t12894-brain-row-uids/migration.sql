-- T12894 (epic T12323) — row uids for the brain text-keyed tables (global store).
--
-- Adds a nullable `uid` column and a unique index on it to every brain table
-- keyed by a TEXT id, plus `birth_fp` on the minted ones, the same shape the
-- T12341 migration gave the task graph. `brain_session_narrative` is natural
-- (one row per session id): `uid` only. Spec: `cleo docs fetch t12341-uid-scheme`.
--
-- The columns are filled by TypeScript at open (store/row-identity.ts, inside
-- the cold-open lease): SQLite has no hash function, and existing rows need a
-- DETERMINISTIC uid so two devices that share a history derive the same one.
-- Rows an older build inserts keep a NULL uid until this build's next open, or
-- get it in the same statement from this build's per-connection TEMP trigger.
-- Nothing here rebuilds a table or touches a row (only ADD COLUMN and CREATE
-- INDEX), so the T12541 rebuild probe and the gate 36 DML rules do not apply;
-- a probe-stamped store gets its columns and indexes from the open's heal.
--
-- @task T12894
-- @epic T12323

ALTER TABLE `brain_decisions` ADD COLUMN `uid` text;
--> statement-breakpoint
ALTER TABLE `brain_decisions` ADD COLUMN `birth_fp` text;
--> statement-breakpoint
ALTER TABLE `brain_patterns` ADD COLUMN `uid` text;
--> statement-breakpoint
ALTER TABLE `brain_patterns` ADD COLUMN `birth_fp` text;
--> statement-breakpoint
ALTER TABLE `brain_learnings` ADD COLUMN `uid` text;
--> statement-breakpoint
ALTER TABLE `brain_learnings` ADD COLUMN `birth_fp` text;
--> statement-breakpoint
ALTER TABLE `brain_observations` ADD COLUMN `uid` text;
--> statement-breakpoint
ALTER TABLE `brain_observations` ADD COLUMN `birth_fp` text;
--> statement-breakpoint
ALTER TABLE `brain_sticky_notes` ADD COLUMN `uid` text;
--> statement-breakpoint
ALTER TABLE `brain_sticky_notes` ADD COLUMN `birth_fp` text;
--> statement-breakpoint
ALTER TABLE `brain_attention` ADD COLUMN `uid` text;
--> statement-breakpoint
ALTER TABLE `brain_attention` ADD COLUMN `birth_fp` text;
--> statement-breakpoint
ALTER TABLE `brain_page_nodes` ADD COLUMN `uid` text;
--> statement-breakpoint
ALTER TABLE `brain_page_nodes` ADD COLUMN `birth_fp` text;
--> statement-breakpoint
ALTER TABLE `brain_transcript_events` ADD COLUMN `uid` text;
--> statement-breakpoint
ALTER TABLE `brain_transcript_events` ADD COLUMN `birth_fp` text;
--> statement-breakpoint
ALTER TABLE `brain_promotion_log` ADD COLUMN `uid` text;
--> statement-breakpoint
ALTER TABLE `brain_promotion_log` ADD COLUMN `birth_fp` text;
--> statement-breakpoint
ALTER TABLE `brain_backfill_runs` ADD COLUMN `uid` text;
--> statement-breakpoint
ALTER TABLE `brain_backfill_runs` ADD COLUMN `birth_fp` text;
--> statement-breakpoint
ALTER TABLE `brain_observations_staging` ADD COLUMN `uid` text;
--> statement-breakpoint
ALTER TABLE `brain_observations_staging` ADD COLUMN `birth_fp` text;
--> statement-breakpoint
ALTER TABLE `brain_session_narrative` ADD COLUMN `uid` text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_brain_decisions_uid` ON `brain_decisions` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_brain_patterns_uid` ON `brain_patterns` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_brain_learnings_uid` ON `brain_learnings` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_brain_observations_uid` ON `brain_observations` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_brain_sticky_notes_uid` ON `brain_sticky_notes` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_brain_attention_uid` ON `brain_attention` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_brain_page_nodes_uid` ON `brain_page_nodes` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_brain_transcript_events_uid` ON `brain_transcript_events` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_brain_promotion_log_uid` ON `brain_promotion_log` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_brain_backfill_runs_uid` ON `brain_backfill_runs` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_brain_observations_staging_uid` ON `brain_observations_staging` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_brain_session_narrative_uid` ON `brain_session_narrative` (`uid`);
