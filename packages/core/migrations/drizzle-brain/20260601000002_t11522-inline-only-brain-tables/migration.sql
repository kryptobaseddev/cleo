-- T11522 (E6-L2): Forward Drizzle migrations for the three brain tables that had
-- NO drizzle-brain migration and were created ONLY by post-hoc
-- `CREATE TABLE IF NOT EXISTS` band-aids in memory-sqlite.ts::runBrainMigrations.
--
-- E6-L2 removes those inline band-aids and replaces them with this forward
-- migration (T11522 AC: post-hoc DDL → forward Drizzle migration), matching the
-- T9179 precedent. The schemas reproduce the removed inline DDL EXACTLY (legacy
-- runtime shape) so the brain runtime writers continue to work unchanged:
--
--   1. brain_transcript_events (T1002) — full-fidelity Claude session block store.
--   2. brain_promotion_log (T1001/T1903) — typed promotion audit trail (includes
--      the T1903 fulfilled_at / fulfillment_note columns folded into the CREATE).
--   3. brain_backfill_runs (T1003) — staged backfill audit log.
--
-- All statements are IF NOT EXISTS so re-running on a DB that already has the
-- tables is idempotent and safe.
CREATE TABLE IF NOT EXISTS `brain_transcript_events` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`role` text NOT NULL,
	`block_type` text NOT NULL,
	`content` text NOT NULL,
	`tokens` integer,
	`redacted_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_transcript_events_session_seq` ON `brain_transcript_events` (`session_id`, `seq`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_transcript_events_session` ON `brain_transcript_events` (`session_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_transcript_events_role` ON `brain_transcript_events` (`role`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_transcript_events_block_type` ON `brain_transcript_events` (`block_type`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `brain_promotion_log` (
	`id` text PRIMARY KEY,
	`observation_id` text NOT NULL,
	`from_tier` text NOT NULL,
	`to_tier` text NOT NULL,
	`score` real NOT NULL,
	`decided_at` text DEFAULT (datetime('now')) NOT NULL,
	`decided_by` text DEFAULT 'composite-scorer' NOT NULL,
	`rationale_json` text,
	`fulfilled_at` text,
	`fulfillment_note` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_promotion_log_observation` ON `brain_promotion_log` (`observation_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_promotion_log_decided_at` ON `brain_promotion_log` (`decided_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_promotion_log_to_tier` ON `brain_promotion_log` (`to_tier`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_promotion_log_score` ON `brain_promotion_log` (`score`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `brain_backfill_runs` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`status` text DEFAULT 'staged' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`approved_at` text,
	`rows_affected` integer DEFAULT 0 NOT NULL,
	`rollback_snapshot_json` text,
	`source` text DEFAULT 'unknown' NOT NULL,
	`target_table` text DEFAULT 'brain_observations' NOT NULL,
	`approved_by` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_backfill_runs_status` ON `brain_backfill_runs` (`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_backfill_runs_kind` ON `brain_backfill_runs` (`kind`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_backfill_runs_created_at` ON `brain_backfill_runs` (`created_at`);
