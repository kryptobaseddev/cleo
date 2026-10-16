-- T13777 (epic T12323) — row uids for the Nexus audit log (global store).
--
-- `nexus_audit_log` is portable, so the home stream's vault snapshots list
-- it, but it had no row identity, so the change journal never carried it and
-- a journal checkpoint could not account for its rows (T12999 staging,
-- 2026-10-16). Adds a nullable `uid` column and a unique index on it. Its id
-- is a UUID, so the uid is natural over it. Spec: `cleo docs fetch t12341-uid-scheme`.
--
-- The column is filled by TypeScript at open (store/row-identity.ts, inside
-- the cold-open lease), and rows inserted by this build get theirs from the
-- per-connection TEMP trigger. Nothing here rebuilds a table or touches a row.
--
-- @task T13777
-- @epic T12323

ALTER TABLE `nexus_audit_log` ADD COLUMN `uid` text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_nexus_audit_log_uid` ON `nexus_audit_log` (`uid`);
