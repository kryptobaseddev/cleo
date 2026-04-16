-- T796: Content-addressed attachment storage
--
-- Adds two tables to tasks.db:
--   attachments       — registry of all attachment blobs (content-addressed by sha256)
--   attachment_refs   — ref-counted junction table linking attachments to owner entities
--
-- Storage layout: .cleo/attachments/sha256/<prefix2>/<rest>.<ext>
-- The `attachment_json` column stores the serialised Attachment discriminated union.
--
-- @epic T760
-- @task T796

CREATE TABLE IF NOT EXISTS `attachments` (
  `id` text PRIMARY KEY NOT NULL,
  `sha256` text NOT NULL,
  `attachment_json` text NOT NULL,
  `created_at` text NOT NULL,
  `ref_count` integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_attachments_sha256` ON `attachments` (`sha256`);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `attachment_refs` (
  `attachment_id` text NOT NULL,
  `owner_type` text NOT NULL,
  `owner_id` text NOT NULL,
  `attached_at` text NOT NULL,
  `attached_by` text,
  CONSTRAINT `attachment_refs_pk` PRIMARY KEY(`attachment_id`, `owner_type`, `owner_id`),
  CONSTRAINT `fk_attachment_refs_attachment_id` FOREIGN KEY (`attachment_id`) REFERENCES `attachments`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_attachment_refs_owner` ON `attachment_refs` (`owner_type`, `owner_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_attachment_refs_attachment_id` ON `attachment_refs` (`attachment_id`);
