-- T12919 (epic T12323) — row uids for the doc registry (project store).
--
-- Adds a nullable `uid` column and a unique index on it to `docs_attachments`
-- (minted: plus `birth_fp`) and `docs_attachment_refs` (natural over its
-- primary key). Without a uid neither table had capture triggers, so a doc
-- added on one device never reached another (Stage C gate, T13549).
-- `docs_wikilinks` gets nothing: it is derived from the doc rows and rebuilt
-- on each device. Spec: `cleo docs fetch t12341-uid-scheme`.
--
-- The columns are filled by TypeScript at open (store/row-identity.ts, inside
-- the cold-open lease), and rows inserted by this build get theirs from the
-- per-connection TEMP trigger. Nothing here rebuilds a table or touches a row
-- (only ADD COLUMN and CREATE INDEX), so the T12541 rebuild probe and the
-- gate 36 DML rules do not apply; a probe-stamped store gets its columns and
-- indexes from the open's heal.
--
-- @task T12919
-- @epic T12323

ALTER TABLE `docs_attachments` ADD COLUMN `uid` text;
--> statement-breakpoint
ALTER TABLE `docs_attachments` ADD COLUMN `birth_fp` text;
--> statement-breakpoint
ALTER TABLE `docs_attachment_refs` ADD COLUMN `uid` text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_docs_attachments_uid` ON `docs_attachments` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_docs_attachment_refs_uid` ON `docs_attachment_refs` (`uid`);
