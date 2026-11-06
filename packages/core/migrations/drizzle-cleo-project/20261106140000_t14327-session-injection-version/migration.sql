-- T14327 — a session records the CLEO-INJECTION version it acknowledged.
--
-- Additive only: one NULL-able column on `tasks_sessions`. `cleo briefing`
-- writes the installed template's `Version:` for the bound session, so
-- `cleo session status` shows per session which protocol version it read;
-- a session that never ran the briefing keeps NULL. No existing row changes.
-- The column syncs with the row; the migration runner regenerates the
-- capture triggers for it.
--
-- @task T14327

ALTER TABLE `tasks_sessions` ADD COLUMN `injection_version` TEXT;
