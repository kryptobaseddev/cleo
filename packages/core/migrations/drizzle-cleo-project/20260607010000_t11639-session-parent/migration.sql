-- T11639 (EP-SESSION-MANIFEST · epic T11638) — add nullable `parent_session_id`
-- to `tasks_sessions` (consolidated PROJECT cleo.db, drizzle-cleo-project scope).
--
-- The fork-tree PARENT session edge: the orchestrator→worker spawn relationship,
-- sourced from CLEO_PARENT_SESSION_ID (stamped by the supervisor — T11629 / PR #996)
-- at session start. Distinct from `previous_session_id` (the linear resume chain).
-- Soft self-reference to `tasks_sessions.id`; nullable so a root session (no spawning
-- parent) and every existing row stay valid.
--
-- No CHECK constraint: `parent_session_id` is a plain free-text soft self-FK (not a
-- timestamp `_at`, boolean, or enum), so the T11363 consolidation-check injector
-- contributes nothing for it.
--
-- Each statement is separated by a drizzle breakpoint marker so node:sqlite prepare()
-- does not truncate the multi-statement file to statement one.
--
-- @task T11639
-- @epic T11638

ALTER TABLE `tasks_sessions` ADD COLUMN `parent_session_id` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tasks_sessions_parent` ON `tasks_sessions` (`parent_session_id`);
