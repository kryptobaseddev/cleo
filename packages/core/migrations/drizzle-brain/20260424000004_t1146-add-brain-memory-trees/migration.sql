-- T1146 Wave 6: Add brain_memory_trees table
--
-- Hierarchical Random Projection Tree (RPTree) nodes for consolidated memory.
-- Trees are rebuilt each dream cycle (full TRUNCATE + repopulate).
-- brain_observations.tree_id references the leaf node after the last cycle.
--
-- DEPENDS ON: 20260424000003_t1145-extend-brain-observations (tree_id column must exist).
--
-- parent_id ON DELETE CASCADE: when a tree is rebuilt (DELETE all), children
-- cascade automatically without orphaned rows.

CREATE TABLE IF NOT EXISTS brain_memory_trees (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  depth       INTEGER NOT NULL DEFAULT 0,
  leaf_ids    TEXT NOT NULL DEFAULT '[]',         -- JSON array of brain_observations.id
  centroid    TEXT,                               -- JSON-encoded float32 array (nullable)
  parent_id   INTEGER REFERENCES brain_memory_trees(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_brain_trees_parent ON brain_memory_trees(parent_id);
CREATE INDEX IF NOT EXISTS idx_brain_trees_depth ON brain_memory_trees(depth);
