-- T811: IVTR orchestration harness — phase state column on tasks
--
-- Adds `ivtr_state` to the `tasks` table.
-- Value is a nullable JSON serialisation of IvtrState.
-- NULL = task has never entered the IVTR loop.
--
-- @epic T810
-- @task T811

ALTER TABLE `tasks` ADD COLUMN `ivtr_state` text;
