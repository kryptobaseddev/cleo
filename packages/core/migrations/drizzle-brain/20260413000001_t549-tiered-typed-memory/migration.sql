-- T549: Tiered + Typed Memory Architecture v2
-- Adds: memory_tier, memory_type (cognitive), verified, valid_at, invalid_at,
--       source_confidence, citation_count to all four typed brain tables.
--
-- Strategy: all columns are nullable or have defaults; no existing rows are broken.
-- NULL-handling contracts: legacy rows are backfilled at the end of this migration.
-- memory_tier NULL → treated as 'medium' at query time (survived T523 purge).
-- memory_type NULL → treated as table default at query time.
-- CONFLICT-03 resolution: citation_count added per cross-validation report (T549-XV).
-- CONFLICT-01 resolution: cognitive type enum is BRAIN_COGNITIVE_TYPES (semantic/episodic/procedural).
-- T553 fix: valid_at columns use nullable DEFAULT (datetime('now')) instead of NOT NULL DEFAULT
--   because SQLite forbids ALTER TABLE ADD COLUMN with a non-constant default on non-empty tables.
--   The backfill UPDATEs at the end of this migration set valid_at = created_at for all existing
--   rows, so no row ever has a NULL valid_at after migration completes.

-- ============================================================
-- brain_decisions
-- ============================================================

ALTER TABLE `brain_decisions` ADD COLUMN `memory_tier` text DEFAULT 'short';
--> statement-breakpoint
ALTER TABLE `brain_decisions` ADD COLUMN `memory_type` text DEFAULT 'semantic';
--> statement-breakpoint
ALTER TABLE `brain_decisions` ADD COLUMN `verified` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `brain_decisions` ADD COLUMN `valid_at` text DEFAULT (datetime('now'));
--> statement-breakpoint
ALTER TABLE `brain_decisions` ADD COLUMN `invalid_at` text;
--> statement-breakpoint
ALTER TABLE `brain_decisions` ADD COLUMN `source_confidence` text DEFAULT 'agent';
--> statement-breakpoint
ALTER TABLE `brain_decisions` ADD COLUMN `citation_count` integer NOT NULL DEFAULT 0;
--> statement-breakpoint

-- ============================================================
-- brain_patterns
-- ============================================================

ALTER TABLE `brain_patterns` ADD COLUMN `memory_tier` text DEFAULT 'short';
--> statement-breakpoint
ALTER TABLE `brain_patterns` ADD COLUMN `memory_type` text DEFAULT 'procedural';
--> statement-breakpoint
ALTER TABLE `brain_patterns` ADD COLUMN `verified` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `brain_patterns` ADD COLUMN `valid_at` text DEFAULT (datetime('now'));
--> statement-breakpoint
ALTER TABLE `brain_patterns` ADD COLUMN `invalid_at` text;
--> statement-breakpoint
ALTER TABLE `brain_patterns` ADD COLUMN `source_confidence` text DEFAULT 'agent';
--> statement-breakpoint
ALTER TABLE `brain_patterns` ADD COLUMN `citation_count` integer NOT NULL DEFAULT 0;
--> statement-breakpoint

-- ============================================================
-- brain_learnings
-- ============================================================

ALTER TABLE `brain_learnings` ADD COLUMN `memory_tier` text DEFAULT 'short';
--> statement-breakpoint
ALTER TABLE `brain_learnings` ADD COLUMN `memory_type` text DEFAULT 'semantic';
--> statement-breakpoint
ALTER TABLE `brain_learnings` ADD COLUMN `verified` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `brain_learnings` ADD COLUMN `valid_at` text DEFAULT (datetime('now'));
--> statement-breakpoint
ALTER TABLE `brain_learnings` ADD COLUMN `invalid_at` text;
--> statement-breakpoint
ALTER TABLE `brain_learnings` ADD COLUMN `source_confidence` text DEFAULT 'agent';
--> statement-breakpoint
ALTER TABLE `brain_learnings` ADD COLUMN `citation_count` integer NOT NULL DEFAULT 0;
--> statement-breakpoint

-- ============================================================
-- brain_observations
-- ============================================================

ALTER TABLE `brain_observations` ADD COLUMN `memory_tier` text DEFAULT 'short';
--> statement-breakpoint
ALTER TABLE `brain_observations` ADD COLUMN `memory_type` text DEFAULT 'episodic';
--> statement-breakpoint
ALTER TABLE `brain_observations` ADD COLUMN `verified` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `brain_observations` ADD COLUMN `valid_at` text DEFAULT (datetime('now'));
--> statement-breakpoint
ALTER TABLE `brain_observations` ADD COLUMN `invalid_at` text;
--> statement-breakpoint
ALTER TABLE `brain_observations` ADD COLUMN `source_confidence` text DEFAULT 'agent';
--> statement-breakpoint
ALTER TABLE `brain_observations` ADD COLUMN `citation_count` integer NOT NULL DEFAULT 0;
--> statement-breakpoint

-- ============================================================
-- Indexes for new columns (query hot paths)
-- ============================================================

CREATE INDEX IF NOT EXISTS `idx_brain_decisions_tier` ON `brain_decisions` (`memory_tier`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_decisions_type` ON `brain_decisions` (`memory_type`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_decisions_verified` ON `brain_decisions` (`verified`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_decisions_valid_at` ON `brain_decisions` (`valid_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_decisions_source_conf` ON `brain_decisions` (`source_confidence`);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_brain_patterns_tier` ON `brain_patterns` (`memory_tier`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_patterns_type` ON `brain_patterns` (`memory_type`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_patterns_verified` ON `brain_patterns` (`verified`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_patterns_valid_at` ON `brain_patterns` (`valid_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_patterns_source_conf` ON `brain_patterns` (`source_confidence`);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_brain_learnings_tier` ON `brain_learnings` (`memory_tier`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_learnings_type` ON `brain_learnings` (`memory_type`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_learnings_verified` ON `brain_learnings` (`verified`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_learnings_valid_at` ON `brain_learnings` (`valid_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_learnings_invalid` ON `brain_learnings` (`invalid_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_learnings_source_conf` ON `brain_learnings` (`source_confidence`);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_brain_observations_tier` ON `brain_observations` (`memory_tier`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_observations_type` ON `brain_observations` (`memory_type`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_observations_verified` ON `brain_observations` (`verified`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_observations_valid_at` ON `brain_observations` (`valid_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_observations_invalid` ON `brain_observations` (`invalid_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_observations_source_conf` ON `brain_observations` (`source_confidence`);
--> statement-breakpoint

-- ============================================================
-- Backfill: legacy rows (survivors of the T523 purge)
-- Treat existing rows as medium-to-long-term based on quality signals.
-- valid_at defaults to created_at so bitemporal queries work correctly.
-- ============================================================

UPDATE `brain_decisions` SET
  memory_tier = CASE
    WHEN confidence = 'high' THEN 'long'
    WHEN confidence = 'medium' THEN 'medium'
    ELSE 'medium'
  END,
  memory_type = 'semantic',
  valid_at = created_at,
  source_confidence = 'agent'
WHERE memory_tier IS NULL;
--> statement-breakpoint

UPDATE `brain_patterns` SET
  memory_tier = CASE
    WHEN frequency >= 5 THEN 'long'
    WHEN frequency >= 2 THEN 'medium'
    ELSE 'medium'
  END,
  memory_type = 'procedural',
  valid_at = extracted_at,
  source_confidence = 'agent'
WHERE memory_tier IS NULL;
--> statement-breakpoint

UPDATE `brain_learnings` SET
  memory_tier = CASE
    WHEN confidence >= 0.80 THEN 'long'
    WHEN confidence >= 0.60 THEN 'medium'
    ELSE 'medium'
  END,
  memory_type = 'semantic',
  valid_at = created_at,
  source_confidence = 'agent'
WHERE memory_tier IS NULL;
--> statement-breakpoint

UPDATE `brain_observations` SET
  memory_tier = 'medium',
  memory_type = 'episodic',
  valid_at = created_at,
  source_confidence = CASE
    WHEN source_type = 'manual' THEN 'owner'
    WHEN source_type = 'session-debrief' THEN 'task-outcome'
    ELSE 'agent'
  END
WHERE memory_tier IS NULL;
