-- Revert T9753: drop the `release_changesets` table + its indexes.
-- Indexes drop implicitly when the table is dropped.
--
-- @task T9753
-- @epic T9752

DROP TABLE IF EXISTS `release_changesets`;
