-- T528: Graph-native memory model — expand brain_page_nodes and brain_page_edges schemas.
-- Adds quality scoring, content hashing, last-activity tracking, provenance, and new
-- indexes to support traversable knowledge graph operations.
--
-- Additive only: all new columns have defaults so existing rows are unaffected.
-- brain_page_nodes has 0 rows and brain_page_edges has 0 rows (confirmed by R1 audit),
-- so no data migration is required.

ALTER TABLE `brain_page_nodes` ADD COLUMN `quality_score` real NOT NULL DEFAULT 0.5;
--> statement-breakpoint
ALTER TABLE `brain_page_nodes` ADD COLUMN `content_hash` text;
--> statement-breakpoint
ALTER TABLE `brain_page_nodes` ADD COLUMN `last_activity_at` text NOT NULL DEFAULT (datetime('now'));
--> statement-breakpoint
ALTER TABLE `brain_page_nodes` ADD COLUMN `updated_at` text;
--> statement-breakpoint
ALTER TABLE `brain_page_edges` ADD COLUMN `provenance` text;
--> statement-breakpoint

-- brain_page_edges.weight was nullable (DEFAULT 1) in the initial schema;
-- changing NOT NULL constraint requires recreating the table in SQLite.
-- Since brain_page_edges has 0 rows, we drop and recreate.
DROP TABLE IF EXISTS `brain_page_edges`;
--> statement-breakpoint
CREATE TABLE `brain_page_edges` (
	`from_id` text NOT NULL,
	`to_id` text NOT NULL,
	`edge_type` text NOT NULL,
	`weight` real NOT NULL DEFAULT 1,
	`provenance` text,
	`created_at` text NOT NULL DEFAULT (datetime('now')),
	CONSTRAINT `brain_page_edges_pk` PRIMARY KEY(`from_id`, `to_id`, `edge_type`)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_brain_nodes_quality` ON `brain_page_nodes` (`quality_score`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_nodes_content_hash` ON `brain_page_nodes` (`content_hash`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_nodes_last_activity` ON `brain_page_nodes` (`last_activity_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_edges_type` ON `brain_page_edges` (`edge_type`);
--> statement-breakpoint
-- Re-create existing edge indexes (dropped with table)
CREATE INDEX IF NOT EXISTS `idx_brain_edges_from` ON `brain_page_edges` (`from_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_edges_to` ON `brain_page_edges` (`to_id`);
