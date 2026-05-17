-- Revert T9506 migration 2/4: drop task_commits table and its indexes.
-- Indexes are dropped implicitly by SQLite when the table is dropped.
--
-- @task T9506

DROP TABLE IF EXISTS `task_commits`;
