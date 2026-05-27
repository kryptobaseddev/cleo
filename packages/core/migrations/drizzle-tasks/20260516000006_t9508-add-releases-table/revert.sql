-- Revert T9508 migration 1/3: drop releases table and its indexes.
-- Indexes are dropped implicitly by SQLite when the table is dropped.
-- NOTE: drop release_commits and release_changes first if they exist (child tables).
--
-- @task T9508

DROP TABLE IF EXISTS `releases`;
