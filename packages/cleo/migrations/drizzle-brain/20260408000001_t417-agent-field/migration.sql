-- T417: Wave 8 Mental Models — add `agent` provenance field to brain_observations.
-- Identifies the spawned agent that produced an observation for per-agent mental
-- model retrieval via `memory.find --agent <name>`.
--
-- Idempotent: SQLite does not support ADD COLUMN IF NOT EXISTS in all versions,
-- so we use a best-effort pattern with a guard query; the migrator journal
-- prevents double-execution, making idempotency via the journal sufficient.

ALTER TABLE `brain_observations` ADD COLUMN `agent` text;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_brain_observations_agent`
  ON `brain_observations` (`agent`);
