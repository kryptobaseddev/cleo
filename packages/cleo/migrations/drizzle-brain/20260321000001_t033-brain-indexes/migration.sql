-- T033: Connection Health Remediation — brain.db indexes (from T031 analysis)
-- INDEX 8: content_hash + created_at (dedup hot path in observeBrain)
-- Drop single-column content_hash index first; composite covers the prefix case.
DROP INDEX IF EXISTS `idx_brain_observations_content_hash`;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_observations_content_hash_created_at`
  ON `brain_observations` (`content_hash`, `created_at`);
--> statement-breakpoint

-- INDEX 9: type + project (findObservations compound filter)
CREATE INDEX IF NOT EXISTS `idx_brain_observations_type_project`
  ON `brain_observations` (`type`, `project`);
