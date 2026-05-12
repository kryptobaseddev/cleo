-- Revert T1897: drop indexes (columns cannot be removed in SQLite without full table rebuild).
DROP INDEX IF EXISTS `idx_brain_observations_origin`;
DROP INDEX IF EXISTS `idx_brain_observations_validated_at`;
