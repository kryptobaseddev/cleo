-- T1897 — Add origin + validated_at + provenance_chain to brain_observations.
--
-- Background:
--   Trust requires provenance. Without producer labeling, the briefing cannot
--   distinguish test-fixture observations from production observations.
--   validated_at records when an owner performed ground-truth verification.
--   provenance_chain tracks lineage for derived/synthesized observations.
--
-- Changes (idempotent ALTER TABLE — safe to re-run):
--   1. origin TEXT — producer pipeline: manual|auto-extract|transcript-ingest|
--      session-debrief|test. Null on legacy rows.
--   2. validated_at TEXT — ISO 8601 timestamp when verified by owner.
--      Null = unverified (agent-inferred only).
--   3. provenance_chain TEXT — JSON array of source observation IDs.
--      Null for directly-observed rows.
--   4. idx_brain_observations_origin — fast filter for briefing field contracts.
--   5. idx_brain_observations_validated_at — fast filter for high-trust queries.
--
-- @task T1897
-- @epic T1892

ALTER TABLE `brain_observations` ADD COLUMN `origin` TEXT;
--> statement-breakpoint
ALTER TABLE `brain_observations` ADD COLUMN `validated_at` TEXT;
--> statement-breakpoint
ALTER TABLE `brain_observations` ADD COLUMN `provenance_chain` TEXT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_observations_origin` ON `brain_observations` (`origin`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_observations_validated_at` ON `brain_observations` (`validated_at`);
