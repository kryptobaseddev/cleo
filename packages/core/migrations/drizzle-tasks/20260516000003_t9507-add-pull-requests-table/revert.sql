-- Revert T9507 migration 1/3: drop pull_requests table and its indexes.
-- Indexes are dropped implicitly by SQLite when the table is dropped.
--
-- @task T9507

DROP TABLE IF EXISTS `pull_requests`;
