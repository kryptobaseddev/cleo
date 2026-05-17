-- Revert T9509 migration 1/2: drop release_artifacts table and its indexes.
-- Indexes are dropped implicitly by SQLite when the table is dropped.
--
-- @task T9509

DROP TABLE IF EXISTS `release_artifacts`;
