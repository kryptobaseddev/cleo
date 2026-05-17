-- Revert T9508 migration 3/3: drop release_changes table.
-- Indexes are dropped implicitly by SQLite when the table is dropped.
--
-- @task T9508

DROP TABLE IF EXISTS `release_changes`;
