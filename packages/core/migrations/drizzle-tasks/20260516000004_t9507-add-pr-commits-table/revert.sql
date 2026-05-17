-- Revert T9507 migration 2/3: drop pr_commits table and its indexes.
-- Indexes are dropped implicitly by SQLite when the table is dropped.
--
-- @task T9507

DROP TABLE IF EXISTS `pr_commits`;
