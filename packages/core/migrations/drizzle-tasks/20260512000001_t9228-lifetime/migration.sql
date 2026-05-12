-- T9228 — Add tasks.lifetime TEXT NULL column for ephemeral task exemption.
--
-- Purpose:
--   Allows tasks to declare their lifecycle scope. Ephemeral tasks
--   (lifetime='session') bypass the W6 verifier requirement — they are
--   short-lived session work that does not need a persistent acceptance check.
--
-- Valid values: 'persistent' (default, NULL) | 'session'
--
-- SQLite supports ALTER TABLE ADD COLUMN for nullable columns.
--
-- @task T9228
-- @adr ADR-070

ALTER TABLE `tasks` ADD COLUMN `lifetime` text;
