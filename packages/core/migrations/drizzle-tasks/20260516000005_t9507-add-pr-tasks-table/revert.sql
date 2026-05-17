-- Revert T9507 migration 3/3: drop pr_tasks table and its indexes.
-- Indexes are dropped implicitly by SQLite when the table is dropped.
--
-- @task T9507

DROP TABLE IF EXISTS `pr_tasks`;
