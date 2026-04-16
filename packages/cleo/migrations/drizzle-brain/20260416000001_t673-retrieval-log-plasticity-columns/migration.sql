-- T673-M1: Plasticity columns for brain_retrieval_log
--
-- Adds two NEW columns to the live table:
--   session_id    — declared in Drizzle at brain-schema.ts but never applied to
--                   the live table via ALTER TABLE (was missing from live DDL)
--   reward_signal — R-STDP third-factor scalar [-1.0, +1.0] (D-BRAIN-VIZ-13)
--
-- NOTE: retrieval_order and delta_ms are NOT added here — they already exist in
-- the live table via the self-healing DDL in brain-sqlite.ts (logRetrieval
-- CREATE TABLE IF NOT EXISTS). The Drizzle schema declaration in brain-schema.ts
-- now includes them for type-safety only (schema drift sync, no migration needed).
--
-- SAFETY: brain_retrieval_log may not exist on a fresh DB (it was created only
-- via self-healing DDL). CREATE TABLE IF NOT EXISTS ensures it exists so the
-- ALTER TABLE statements can succeed on fresh installs.
--
-- All UPDATE statements are idempotent via their WHERE clauses.
-- Migration sequence: M1 must precede M2/M3/M4.
-- Spec ref: docs/specs/stdp-wire-up-spec.md §5.1

CREATE TABLE IF NOT EXISTS `brain_retrieval_log` (
  `id` integer PRIMARY KEY AUTOINCREMENT,
  `query` text NOT NULL,
  `entry_ids` text NOT NULL,
  `entry_count` integer NOT NULL,
  `source` text NOT NULL,
  `tokens_used` integer,
  `created_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint

ALTER TABLE `brain_retrieval_log` ADD COLUMN `session_id` text;
--> statement-breakpoint
ALTER TABLE `brain_retrieval_log` ADD COLUMN `reward_signal` real;
--> statement-breakpoint

-- Convert comma-separated entry_ids to JSON array format (idempotent).
-- Rows already in JSON format (starting with '[') are untouched.
-- Fixes BUG-2: readers call JSON.parse() but writer stored CSV.
-- Per spec §2.3.
UPDATE `brain_retrieval_log`
SET entry_ids = '["' || REPLACE(entry_ids, ',', '","') || '"]'
WHERE entry_ids IS NOT NULL AND entry_ids != '' AND entry_ids NOT LIKE '[%';
--> statement-breakpoint

-- Backfill synthetic session IDs for historical rows (spec §2.4 / T715).
-- One ses_backfill_YYYY-MM-DD per calendar day in created_at.
-- Rows already having a session_id are untouched (idempotent).
-- backfillRewardSignals MUST skip rows where session_id LIKE 'ses_backfill_%'.
UPDATE `brain_retrieval_log`
SET session_id = 'ses_backfill_' || substr(created_at, 1, 10)
WHERE session_id IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_retrieval_log_reward` ON `brain_retrieval_log` (`reward_signal`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_retrieval_log_session` ON `brain_retrieval_log` (`session_id`);
