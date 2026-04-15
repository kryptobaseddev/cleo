-- T673-M1: Plasticity columns for brain_retrieval_log
--
-- Adds four columns needed by the STDP writer (T673/T703/T715):
--   session_id      — declared in Drizzle at brain-schema.ts:715 but never
--                     applied to the live table via ALTER TABLE
--   reward_signal   — R-STDP third-factor scalar [-1.0, +1.0] (D-BRAIN-VIZ-13)
--   retrieval_order — already present in the live table via self-healing DDL;
--                     this brings the Drizzle declaration into sync with reality
--   delta_ms        — same drift situation as retrieval_order
--
-- Idempotent: SQLite silently ignores ADD COLUMN when the column already exists
-- in some builds; we rely on the migration journal to skip already-applied files.
-- The UPDATE statements are unconditionally idempotent via their WHERE clauses.
--
-- SAFETY: brain_retrieval_log is not in the initial migration — it was created
-- only via self-healing DDL in brain-sqlite.ts. On a fresh DB this migration
-- runs before the self-healing code. CREATE TABLE IF NOT EXISTS ensures the
-- table exists so the ALTER TABLE statements below can succeed.
--
-- Migration sequence: M1 (this file) must precede M2/M3/M4.
-- Part of: docs/specs/stdp-wire-up-spec.md §5.1

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
ALTER TABLE `brain_retrieval_log` ADD COLUMN `retrieval_order` integer;
--> statement-breakpoint
ALTER TABLE `brain_retrieval_log` ADD COLUMN `delta_ms` integer;
--> statement-breakpoint

-- Convert comma-separated entry_ids to JSON array format (idempotent).
-- Rows already in JSON format (starting with '[') are untouched.
-- Per spec §2.3 -- fixes BUG-2: readers call JSON.parse() but writer stored CSV.
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
