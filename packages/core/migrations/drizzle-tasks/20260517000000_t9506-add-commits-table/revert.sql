-- Revert T9506 migration 1/4: drop commits table and its indexes.
-- Indexes are dropped implicitly by SQLite when the table is dropped.
--
-- @task T9506

DROP TABLE IF EXISTS `commits`;
