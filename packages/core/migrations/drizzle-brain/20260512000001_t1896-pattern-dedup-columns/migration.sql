-- T1896: Add occurrence_count and last_seen_at to brain_patterns for near-duplicate dedup.
--
-- Brain patterns had a 4.4x bloat ratio (12,390 rows for 2,819 observations).
-- Three near-identical "Agent type X fails on task type Y" rows in a 21s window
-- proved that dedup was missing at extraction time.
--
-- These two columns enable the dedupePatterns consolidation step (brain-consolidator.ts)
-- to collapse near-duplicate rows without losing occurrence history:
--
--   occurrence_count — how many times this pattern was observed (kept oldest row, sum counts)
--   last_seen_at     — ISO 8601 timestamp of most-recent occurrence (for freshness tracking)
--
-- SAFE FOR: SQLite 3.35+ (ALTER TABLE ADD COLUMN is atomic)

ALTER TABLE brain_patterns ADD COLUMN occurrence_count INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE brain_patterns ADD COLUMN last_seen_at TEXT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_brain_patterns_occurrence_count
  ON brain_patterns (occurrence_count);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_brain_patterns_last_seen_at
  ON brain_patterns (last_seen_at);
