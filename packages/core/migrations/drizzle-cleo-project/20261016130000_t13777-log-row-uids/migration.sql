-- T13777 (epic T12323) — row uids for the logs every command writes (project
-- store): token usage and the session handoff entries.
--
-- Both tables are portable, so every vault snapshot lists them, but neither
-- had row identity, so the change journal never carried them: a journal
-- checkpoint could not account for their rows and `cleo cloud push` refused
-- on every real store (T12999 staging, 2026-10-16). Adds a nullable `uid`
-- column and a unique index on it to each. Spec: `cleo docs fetch t12341-uid-scheme`.
--
-- The write-once guard on the handoff entries was `BEFORE UPDATE` with no
-- column list, so it aborted the uid fill and the per-connection uid trigger
-- (journal spec §2.11 §7 note for T12341). It is re-created as `BEFORE UPDATE
-- OF` the content columns: the handoff stays write-once, and its identity
-- columns can be filled.
--
-- The columns are filled by TypeScript at open (store/row-identity.ts, inside
-- the cold-open lease), and rows inserted by this build get theirs from the
-- per-connection TEMP trigger. Nothing here rebuilds a table or touches a row.
--
-- @task T13777
-- @epic T12323

ALTER TABLE `tasks_token_usage` ADD COLUMN `uid` text;
--> statement-breakpoint
ALTER TABLE `tasks_session_handoff_entries` ADD COLUMN `uid` text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_tasks_token_usage_uid` ON `tasks_token_usage` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_tasks_session_handoff_entries_uid` ON `tasks_session_handoff_entries` (`uid`);
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_tasks_session_handoff_no_update`;
--> statement-breakpoint
CREATE TRIGGER `trg_tasks_session_handoff_no_update`
BEFORE UPDATE OF `handoff_json`, `created_at` ON `tasks_session_handoff_entries`
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM cleo_trigger_suspend WHERE scope IN ('guard', 'all'))
BEGIN
  SELECT RAISE(
    ABORT,
    'T1609_HANDOFF_IMMUTABLE: session_handoff_entries rows are write-once. Use persistHandoff() exactly once per session.'
  );
END;
