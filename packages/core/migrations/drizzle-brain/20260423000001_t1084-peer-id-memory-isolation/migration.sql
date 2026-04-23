-- T1084 PSYCHE Wave 2: Add peer_id + peer_scope to brain memory tables
--
-- Context: T1081 Wave 2 CANT Peer Memory Isolation.
-- Adds two columns to brain_decisions, brain_patterns, brain_learnings,
-- and brain_observations to support per-CANT-agent memory isolation,
-- mirroring PSYCHE's peer-scoped workspace model.
--
-- peer_id   TEXT NOT NULL DEFAULT 'global'
--   Identifies the CANT agent that produced this entry.
--   'global' = shared across all peers (legacy rows + unscoped writes).
--   A specific peer ID (e.g. 'cleo-prime') restricts visibility to that peer.
--
-- peer_scope  TEXT NOT NULL DEFAULT 'project'
--   Determines the visibility radius:
--   'global'  — visible to all peers in this project (no isolation).
--   'project' — scoped to current project; default for peer-written entries.
--   'peer'    — strict per-peer isolation; only the owning peer retrieves.
--
-- Staged backfill (T1003 pattern):
--   Existing rows receive peer_id='global', peer_scope='project' via the
--   DEFAULT constraint — no explicit UPDATE required for the NOT NULL guarantee.
--   The defaults are semantically correct (legacy entries belong to the
--   global shared pool) so backward compatibility is preserved.
--
-- Compound index idx_peer_scope covers the retrieval filter:
--   WHERE peer_id = ? OR peer_id = 'global'
--
-- Reversibility: additive NOT NULL + DEFAULT columns. Droppable in SQLite 3.35+.

-- brain_decisions
ALTER TABLE brain_decisions ADD COLUMN peer_id TEXT NOT NULL DEFAULT 'global';
--> statement-breakpoint
ALTER TABLE brain_decisions ADD COLUMN peer_scope TEXT NOT NULL DEFAULT 'project';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_decisions_peer_scope`
  ON `brain_decisions` (`peer_id`, `peer_scope`);
--> statement-breakpoint

-- brain_patterns
ALTER TABLE brain_patterns ADD COLUMN peer_id TEXT NOT NULL DEFAULT 'global';
--> statement-breakpoint
ALTER TABLE brain_patterns ADD COLUMN peer_scope TEXT NOT NULL DEFAULT 'project';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_patterns_peer_scope`
  ON `brain_patterns` (`peer_id`, `peer_scope`);
--> statement-breakpoint

-- brain_learnings
ALTER TABLE brain_learnings ADD COLUMN peer_id TEXT NOT NULL DEFAULT 'global';
--> statement-breakpoint
ALTER TABLE brain_learnings ADD COLUMN peer_scope TEXT NOT NULL DEFAULT 'project';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_learnings_peer_scope`
  ON `brain_learnings` (`peer_id`, `peer_scope`);
--> statement-breakpoint

-- brain_observations
ALTER TABLE brain_observations ADD COLUMN peer_id TEXT NOT NULL DEFAULT 'global';
--> statement-breakpoint
ALTER TABLE brain_observations ADD COLUMN peer_scope TEXT NOT NULL DEFAULT 'project';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_observations_peer_scope`
  ON `brain_observations` (`peer_id`, `peer_scope`);
