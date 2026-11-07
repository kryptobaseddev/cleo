-- T14288 (workstream E, PR 3a; D11226) — the doc's metadata on its immutable
-- identity row.
--
-- A doc is the conduit uid (`conduit_attachments.uid`); its metadata lived on
-- whichever `docs_attachments` row carried its slug, a row an update replaces.
-- These nullable columns carry it on the uid instead: the kind, lifecycle,
-- supersession (as doc uids, which travel verbatim like
-- `conduit_doc_heads.attachment_uid`), summary, keywords, topics, related
-- tasks, the ADR display number and the writing release. The writers mirror
-- the registry row into them (PR 3a); the readers move to them in PR 3b.
--
-- Forward-only and additive: every column is nullable, no default, no DML —
-- the accessors populate them, so the change journal records every value.
-- The columns are appended in schema order (after `birth_fp`).
--
-- @task T14288

ALTER TABLE `conduit_attachments` ADD COLUMN `doc_type` text;
--> statement-breakpoint
ALTER TABLE `conduit_attachments` ADD COLUMN `lifecycle_status` text;
--> statement-breakpoint
ALTER TABLE `conduit_attachments` ADD COLUMN `supersedes_uid` text;
--> statement-breakpoint
ALTER TABLE `conduit_attachments` ADD COLUMN `superseded_by_uid` text;
--> statement-breakpoint
ALTER TABLE `conduit_attachments` ADD COLUMN `summary` text;
--> statement-breakpoint
ALTER TABLE `conduit_attachments` ADD COLUMN `keywords` text;
--> statement-breakpoint
ALTER TABLE `conduit_attachments` ADD COLUMN `topics` text;
--> statement-breakpoint
ALTER TABLE `conduit_attachments` ADD COLUMN `related_tasks` text;
--> statement-breakpoint
ALTER TABLE `conduit_attachments` ADD COLUMN `display_alias` integer;
--> statement-breakpoint
ALTER TABLE `conduit_attachments` ADD COLUMN `owner_version` text;
