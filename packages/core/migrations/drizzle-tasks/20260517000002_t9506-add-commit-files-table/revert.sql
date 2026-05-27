-- Revert T9506 migration 3/4: drop commit_files table and its indexes.
-- Indexes are dropped implicitly by SQLite when the table is dropped.
--
-- @task T9506

DROP TABLE IF EXISTS `commit_files`;
