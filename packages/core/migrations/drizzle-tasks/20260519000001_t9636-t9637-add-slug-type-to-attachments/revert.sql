-- Revert T9636 / T9637 — drop the slug and type columns + indexes.
--
-- SQLite supports ALTER TABLE DROP COLUMN since v3.35 (2021), so this is a
-- straightforward reversal. The unique partial index on slug is implicitly
-- dropped when the slug column is dropped — listed explicitly for clarity.

DROP INDEX IF EXISTS `uniq_attachments_slug`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_attachments_type`;
--> statement-breakpoint
ALTER TABLE `attachments` DROP COLUMN `slug`;
--> statement-breakpoint
ALTER TABLE `attachments` DROP COLUMN `type`;
