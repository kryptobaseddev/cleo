-- T11545: Partition the Hebbian plasticity columns out of `nexus_relations`
-- into the sibling 1:1 table `nexus_relation_weights` (ADR-090 §5.3).
--
-- The write-heavy plasticity columns (`weight`, `last_accessed_at`,
-- `co_accessed_count`) added by T998 are moved off the read-mostly structural
-- graph row so structural queries scan a narrower row and the Hebbian hot path
-- writes only the sibling table. A relation has at most one weights row, keyed
-- by `relation_id` (soft FK -> `nexus_relations.id`). Rows are created lazily on
-- the first co-access strengthening event, so absence == "never strengthened"
-- (weight 0.0).
--
-- Forward migration order:
--   1. CREATE the sibling table + indexes.
--   2. Backfill: copy any relation that already carries non-default plasticity
--      state (weight > 0, a recorded last_accessed_at, or co_accessed_count > 0)
--      into the new table. Pristine rows are intentionally NOT copied (absence
--      == weight 0.0), matching the lazy-create semantics.
--   3. DROP the three legacy columns + the old index from `nexus_relations`.
--      SQLite ALTER TABLE ... DROP COLUMN requires SQLite >= 3.35 (Node 24's
--      bundled SQLite is 3.53+).
--
-- Legacy DBs where the T998 columns exist hit the backfill + drop path. Fresh
-- DBs created after T11539's residency move never had the columns inline, but
-- the backfill SELECT references them; the ensureNexusRelationWeights() safety
-- net in nexus-sqlite.ts handles the column-absent path idempotently (the
-- migration chain itself always runs on a DB where the prior T998 migration
-- already added the columns, so the references resolve).
CREATE TABLE IF NOT EXISTS `nexus_relation_weights` (
	`relation_id` text PRIMARY KEY NOT NULL,
	`weight` real DEFAULT 0.0 NOT NULL,
	`last_accessed_at` text,
	`co_accessed_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_nexus_relation_weights_last_accessed` ON `nexus_relation_weights` (`last_accessed_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_nexus_relation_weights_weight` ON `nexus_relation_weights` (`weight`);
--> statement-breakpoint
INSERT OR IGNORE INTO `nexus_relation_weights` (`relation_id`, `weight`, `last_accessed_at`, `co_accessed_count`)
SELECT `id`, COALESCE(`weight`, 0.0), `last_accessed_at`, COALESCE(`co_accessed_count`, 0)
FROM `nexus_relations`
WHERE COALESCE(`weight`, 0.0) > 0.0
   OR `last_accessed_at` IS NOT NULL
   OR COALESCE(`co_accessed_count`, 0) > 0;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_nexus_relations_last_accessed`;
--> statement-breakpoint
ALTER TABLE `nexus_relations` DROP COLUMN `weight`;
--> statement-breakpoint
ALTER TABLE `nexus_relations` DROP COLUMN `last_accessed_at`;
--> statement-breakpoint
ALTER TABLE `nexus_relations` DROP COLUMN `co_accessed_count`;
