-- Revert T9508 migration 2/3: drop release_commits table.
-- Indexes are dropped implicitly by SQLite when the table is dropped.
--
-- @task T9508

DROP TABLE IF EXISTS `release_commits`;
