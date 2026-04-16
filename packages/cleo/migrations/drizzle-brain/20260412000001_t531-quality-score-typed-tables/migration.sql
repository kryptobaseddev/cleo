-- T531: Wire quality scoring into brain memory store functions.
-- Adds quality_score column to the four typed brain tables.
-- NULL is used for legacy rows (not yet scored); new rows get a computed score.
-- Search filtering uses "IS NULL OR quality_score >= 0.3" so legacy entries are retained.
--
-- Additive only: all columns are nullable so existing rows are unaffected.

ALTER TABLE `brain_decisions` ADD COLUMN `quality_score` real;
--> statement-breakpoint
ALTER TABLE `brain_patterns` ADD COLUMN `quality_score` real;
--> statement-breakpoint
ALTER TABLE `brain_learnings` ADD COLUMN `quality_score` real;
--> statement-breakpoint
ALTER TABLE `brain_observations` ADD COLUMN `quality_score` real;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_brain_decisions_quality` ON `brain_decisions` (`quality_score`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_patterns_quality` ON `brain_patterns` (`quality_score`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_learnings_quality` ON `brain_learnings` (`quality_score`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_observations_quality` ON `brain_observations` (`quality_score`);
