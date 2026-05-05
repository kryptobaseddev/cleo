-- T1839: FTS5 virtual table for BM25 search on nexus_nodes.
-- Replaces O(n) LIKE '%pattern%' scans in augment.ts with indexed BM25 MATCH queries.
-- Target: p50 < 50ms (vs 1.8s LIKE baseline on cleocode project).
--
-- Design:
--   - FTS5 standalone table (not content table) — simpler trigger management.
--   - Indexes label + file_path (the two columns searched in augment.ts).
--   - node_id stored UNINDEXED for id resolution post-search.
--   - Triggers maintain the FTS5 table on INSERT/UPDATE/DELETE from nexus_nodes.
--   - Backfill INSERT populates existing rows idempotently.
--
-- Note: node:sqlite does not support the FTS5 content-virtual-table delete
-- syntax `INSERT INTO fts(fts, rowid, ...) VALUES ('delete', ...)`. Triggers
-- use plain `DELETE FROM nexus_symbols_fts WHERE rowid = old.rowid` instead,
-- which works reliably across all supported SQLite versions.
--
-- Safe to re-run: all DDL uses IF NOT EXISTS / DROP IF EXISTS guards.

-- 1. FTS5 virtual table: label + file_path indexed, node_id stored for lookup.
CREATE VIRTUAL TABLE IF NOT EXISTS nexus_symbols_fts USING fts5(
  node_id UNINDEXED,
  label,
  file_path,
  tokenize = 'unicode61 remove_diacritics 1'
);

--> statement-breakpoint
-- 2a. INSERT trigger.
DROP TRIGGER IF EXISTS nexus_nodes_fts_ai;
--> statement-breakpoint
CREATE TRIGGER nexus_nodes_fts_ai
AFTER INSERT ON nexus_nodes
BEGIN
  INSERT INTO nexus_symbols_fts(rowid, node_id, label, file_path)
  VALUES (new.rowid, new.id, new.label, new.file_path);
END;

--> statement-breakpoint
-- 2b. DELETE trigger.
DROP TRIGGER IF EXISTS nexus_nodes_fts_ad;
--> statement-breakpoint
CREATE TRIGGER nexus_nodes_fts_ad
AFTER DELETE ON nexus_nodes
BEGIN
  DELETE FROM nexus_symbols_fts WHERE rowid = old.rowid;
END;

--> statement-breakpoint
-- 2c. UPDATE trigger — delete old entry, insert new entry.
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
-- 3. Backfill existing nexus_nodes rows into FTS5.
-- The NOT IN guard makes this idempotent across repeated runs.
INSERT INTO nexus_symbols_fts(rowid, node_id, label, file_path)
SELECT rowid, id, label, file_path
FROM nexus_nodes
WHERE rowid NOT IN (
  SELECT rowid FROM nexus_symbols_fts
);
