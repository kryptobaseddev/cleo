-- Revert T9509 migration 2/2: drop brain_release_links table and its indexes.
-- Indexes are dropped implicitly by SQLite when the table is dropped.
--
-- @task T9509

DROP TABLE IF EXISTS `brain_release_links`;
