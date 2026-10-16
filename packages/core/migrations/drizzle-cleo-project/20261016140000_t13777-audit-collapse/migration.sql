-- T13777 part 2 (epic T12323) — the dispatch audit moves into `tasks_audit_log`,
-- which gets a row uid and syncs.
--
-- Every command writes an audit row. The dispatch audit went to the bare
-- `audit_log` and the task-mutation audit to `tasks_audit_log`; neither had
-- row identity, so the change journal carried neither, and a journal
-- checkpoint could not account for their rows (T12999 staging, 2026-10-16).
-- This build writes the dispatch audit into the twin, the twin collapse drains
-- the bare rows into it (store/twin-collapse.ts, lossless), and the twin is
-- declared natural on `id`.
--
-- `dispatch_idempotency_key` holds a dispatch request's idempotency key. One
-- key may record several rows (a failed attempt, then its retry), which
-- UNIQUE(project_hash, domain, operation, idempotency_key) on the twin would
-- refuse, so the key lives outside that constraint; the idempotent replay
-- reads it through the index below.
--
-- The columns are filled by TypeScript at open (store/row-identity.ts, inside
-- the cold-open lease), and rows inserted by this build get theirs from the
-- per-connection TEMP trigger. Nothing here rebuilds a table or touches a row.
--
-- @task T13777
-- @epic T12323

ALTER TABLE `tasks_audit_log` ADD COLUMN `uid` text;
--> statement-breakpoint
ALTER TABLE `tasks_audit_log` ADD COLUMN `dispatch_idempotency_key` text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_tasks_audit_log_uid` ON `tasks_audit_log` (`uid`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tasks_audit_log_dispatch_idempotency` ON `tasks_audit_log` (`project_hash`, `domain`, `operation`, `dispatch_idempotency_key`);
