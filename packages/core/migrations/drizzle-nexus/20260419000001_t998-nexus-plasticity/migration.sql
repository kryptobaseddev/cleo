-- T998: NEXUS plasticity columns — Hebbian co-access strengthening.
-- Adds weight, last_accessed_at, and co_accessed_count to nexus_relations so
-- edges can be strengthened each time the connected nodes are co-accessed
-- during retrieval (fire-together-wire-together principle).
-- Migration is idempotent: ALTER TABLE ADD COLUMN is a no-op if column exists (via ensureColumns band-aid in nexus-sqlite.ts).

ALTER TABLE `nexus_relations` ADD COLUMN `weight` real DEFAULT 0.0;
--> statement-breakpoint
ALTER TABLE `nexus_relations` ADD COLUMN `last_accessed_at` text;
--> statement-breakpoint
ALTER TABLE `nexus_relations` ADD COLUMN `co_accessed_count` integer DEFAULT 0;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_nexus_relations_last_accessed` ON `nexus_relations` (`last_accessed_at`);
