-- T1609 — DOWN MIGRATION (manual rollback only).
--
-- This file is NOT consumed by drizzle-kit.
-- Apply with:
--   sqlite3 .cleo/tasks.db < packages/core/migrations/drizzle-tasks/20260429000000_t1609-handoff-append-only/revert.sql
--
-- Steps:
--   1. Drop the write-once trigger.
--   2. Drop the mirror trigger.
--   3. Drop the table (cascades the unique index).
--
-- NOTE: After rollback, sessions.handoff_json values written via the new path
-- remain intact in the sessions table (the AFTER INSERT trigger kept them in
-- sync), so no data is lost.
--
-- @task T1609

PRAGMA foreign_keys = OFF;

DROP TRIGGER IF EXISTS `trg_session_handoff_no_update`;
DROP TRIGGER IF EXISTS `trg_session_handoff_mirror`;
DROP INDEX  IF EXISTS `idx_session_handoff_session_id`;
DROP TABLE  IF EXISTS `session_handoff_entries`;

PRAGMA foreign_keys = ON;
