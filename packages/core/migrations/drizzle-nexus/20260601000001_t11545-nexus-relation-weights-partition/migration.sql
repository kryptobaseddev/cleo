-- T11545 (ADR-090 §5.3) → T11578 (AC3 · COMPLETE-CUTOVER): nexus delta over the
-- consolidated `nexus_*` tables.
--
-- ## History
--
-- T11545 partitioned the Hebbian plasticity columns (`weight`,
-- `last_accessed_at`, `co_accessed_count`) out of `nexus_relations` into the
-- sibling 1:1 `nexus_relation_weights` table.
--
-- ## AC3 cutover (T11578)
--
-- The nexus runtime READ + WRITE path now targets the PREFIXED consolidated
-- tables (`nexus_project_registry`, `nexus_user_profile`, `nexus_sigils`,
-- `nexus_project_id_aliases`, `nexus_nodes`, `nexus_relations`, …) that the
-- consolidated cleo-global migration
-- (`drizzle-cleo-global/…t11363-consolidation-cleo-global`) creates. Those 10
-- prefixed base tables are therefore NO LONGER created here — the consolidated
-- migration owns them (single SSoT; CHECK constraints + ISO-8601 TEXT timestamp
-- affinity are injected by T11363). This migration's remaining responsibility is:
--
--   1. the `nexus_relation_weights` sibling table (the consolidated GLOBAL
--      migration's `nexus_relations` still carries the inline plasticity columns
--      — the matching column-DROP is applied idempotently in `nexus-sqlite.ts`
--      `ensureNexusRelationWeights`, never as a non-idempotent journaled ALTER);
--   2. the `nexus_symbols_fts` FTS5 virtual table + its three `nexus_nodes` sync
--      triggers — drizzle-orm sqlite-core cannot model FTS5, so the consolidated
--      migration omits them;
--   3. the legacy `_nexus_meta` health-probe table — pinned as the reconcile
--      sentinel (a table THIS migration creates, NOT a consolidated-owned one) so
--      `reconcileJournal` Scenario 2 stays dormant until the nexus set is
--      journaled (mirrors the conduit `_conduit_meta` sentinel, T11578 · AC4).
--
-- Every statement is `IF NOT EXISTS` / `DROP … IF EXISTS` — idempotent across
-- repeated opens and the orphan re-probe path.

-- -------------------------------------------------------------------------
-- 1. Plasticity weights sibling (1:1 with nexus_relations.id).
-- -------------------------------------------------------------------------
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

-- -------------------------------------------------------------------------
-- 2. FTS5 full-text index over nexus_nodes (label + file_path) + triggers.
--    The consolidated migration cannot model FTS5 virtual tables.
-- -------------------------------------------------------------------------
CREATE VIRTUAL TABLE IF NOT EXISTS nexus_symbols_fts USING fts5(
	node_id UNINDEXED,
	label,
	file_path,
	tokenize = 'unicode61 remove_diacritics 1'
);
--> statement-breakpoint
DROP TRIGGER IF EXISTS nexus_nodes_fts_ai;
--> statement-breakpoint
CREATE TRIGGER nexus_nodes_fts_ai
AFTER INSERT ON nexus_nodes
BEGIN
	INSERT INTO nexus_symbols_fts(rowid, node_id, label, file_path)
	VALUES (new.rowid, new.id, new.label, new.file_path);
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS nexus_nodes_fts_ad;
--> statement-breakpoint
CREATE TRIGGER nexus_nodes_fts_ad
AFTER DELETE ON nexus_nodes
BEGIN
	DELETE FROM nexus_symbols_fts WHERE rowid = old.rowid;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS nexus_nodes_fts_au;
--> statement-breakpoint
CREATE TRIGGER nexus_nodes_fts_au
AFTER UPDATE ON nexus_nodes
BEGIN
	DELETE FROM nexus_symbols_fts WHERE rowid = old.rowid;
	INSERT INTO nexus_symbols_fts(rowid, node_id, label, file_path)
	VALUES (new.rowid, new.id, new.label, new.file_path);
END;
--> statement-breakpoint

-- -------------------------------------------------------------------------
-- 3. Legacy meta health-probe table + reconcile sentinel (T11578 · AC3).
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS _nexus_meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL,
	updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
