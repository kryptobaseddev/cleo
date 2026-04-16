-- T726 Wave 1A: Memory dedup gates + tier promotion audit columns
--
-- T741 + T743: Add tier_promoted_at + tier_promotion_reason to all 4 memory tables.
--   Enables auditable promotion history without a separate log table.
-- T737: Add content_hash to brain_decisions, brain_patterns, brain_learnings.
--   All three tables had the column in the original design intent (hash-dedup for all
--   typed tables) but it was only added to brain_observations in T033. This migration
--   closes the gap so hashDedupCheck() can gate all four tables.
-- T746: No DDL needed — the DEFAULT 'medium' fix is a Drizzle-schema-only correction.
--   Existing rows already have 'medium' assigned by the write-path; only the Drizzle
--   column declaration was wrong (DEFAULT 'short' vs 'medium').
--
-- All ALTER statements are idempotent-safe: columns are nullable, added after existing
-- columns, no NOT NULL without a default.

-- ============================================================
-- brain_decisions — tier promotion audit + content_hash
-- ============================================================

ALTER TABLE `brain_decisions` ADD COLUMN `tier_promoted_at` text;
--> statement-breakpoint
ALTER TABLE `brain_decisions` ADD COLUMN `tier_promotion_reason` text;
--> statement-breakpoint
ALTER TABLE `brain_decisions` ADD COLUMN `content_hash` text;
--> statement-breakpoint

-- ============================================================
-- brain_patterns — tier promotion audit + content_hash
-- ============================================================

ALTER TABLE `brain_patterns` ADD COLUMN `tier_promoted_at` text;
--> statement-breakpoint
ALTER TABLE `brain_patterns` ADD COLUMN `tier_promotion_reason` text;
--> statement-breakpoint
ALTER TABLE `brain_patterns` ADD COLUMN `content_hash` text;
--> statement-breakpoint

-- ============================================================
-- brain_learnings — tier promotion audit + content_hash
-- ============================================================

ALTER TABLE `brain_learnings` ADD COLUMN `tier_promoted_at` text;
--> statement-breakpoint
ALTER TABLE `brain_learnings` ADD COLUMN `tier_promotion_reason` text;
--> statement-breakpoint
ALTER TABLE `brain_learnings` ADD COLUMN `content_hash` text;
--> statement-breakpoint

-- ============================================================
-- brain_observations — tier promotion audit only
-- (content_hash already exists from T033)
-- ============================================================

ALTER TABLE `brain_observations` ADD COLUMN `tier_promoted_at` text;
--> statement-breakpoint
ALTER TABLE `brain_observations` ADD COLUMN `tier_promotion_reason` text;
--> statement-breakpoint

-- ============================================================
-- Indexes on tier_promoted_at for promotion history queries
-- ============================================================

CREATE INDEX IF NOT EXISTS `idx_brain_decisions_tier_promoted_at` ON `brain_decisions` (`tier_promoted_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_patterns_tier_promoted_at` ON `brain_patterns` (`tier_promoted_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_learnings_tier_promoted_at` ON `brain_learnings` (`tier_promoted_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_observations_tier_promoted_at` ON `brain_observations` (`tier_promoted_at`);
--> statement-breakpoint

-- Indexes on content_hash for the new typed tables (mirrors obs index pattern)
CREATE INDEX IF NOT EXISTS `idx_brain_decisions_content_hash` ON `brain_decisions` (`content_hash`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_patterns_content_hash` ON `brain_patterns` (`content_hash`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_learnings_content_hash` ON `brain_learnings` (`content_hash`);
