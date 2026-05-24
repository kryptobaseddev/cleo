-- Revert T10158 — drop the 7 docs-provenance columns + 2 indices.
--
-- SQLite supports ALTER TABLE DROP COLUMN since v3.35 (2021). Dropping
-- a column implicitly drops indexes that reference it, but we list them
-- explicitly for clarity and to keep the reversal idempotent.
--
-- Self-referential FKs (supersedes / superseded_by) drop with the columns.

DROP INDEX IF EXISTS `idx_attachments_lifecycle_status`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_attachments_supersedes`;
--> statement-breakpoint
ALTER TABLE `attachments` DROP COLUMN `lifecycle_status`;
--> statement-breakpoint
ALTER TABLE `attachments` DROP COLUMN `supersedes`;
--> statement-breakpoint
ALTER TABLE `attachments` DROP COLUMN `superseded_by`;
--> statement-breakpoint
ALTER TABLE `attachments` DROP COLUMN `summary`;
--> statement-breakpoint
ALTER TABLE `attachments` DROP COLUMN `keywords`;
--> statement-breakpoint
ALTER TABLE `attachments` DROP COLUMN `topics`;
--> statement-breakpoint
ALTER TABLE `attachments` DROP COLUMN `related_tasks`;
