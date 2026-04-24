-- T1145 Wave 5: Extend brain_observations with deriver lineage columns
--
-- Adds 4 columns for derivation lineage tracking and tree membership:
--   source_ids    — JSON array of ancestor observation IDs (derivation lineage)
--   times_derived — how many times this entry has been re-derived (default 1)
--   level         — 'explicit' (directly observed) | 'inductive' (synthesized by deriver)
--   tree_id       — FK to brain_memory_trees.id (assigned by dream cycle, T1146)
--
-- level CHECK is enforced at application level (not SQL constraint per Lesson 3).
-- NULL semantics: level NULL -> treat as 'explicit' at query time.

ALTER TABLE brain_observations ADD COLUMN source_ids TEXT;
ALTER TABLE brain_observations ADD COLUMN times_derived INTEGER DEFAULT 1;
ALTER TABLE brain_observations ADD COLUMN level TEXT DEFAULT 'explicit';
ALTER TABLE brain_observations ADD COLUMN tree_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_brain_observations_level
  ON brain_observations(level);

CREATE INDEX IF NOT EXISTS idx_brain_observations_tree_id
  ON brain_observations(tree_id);
