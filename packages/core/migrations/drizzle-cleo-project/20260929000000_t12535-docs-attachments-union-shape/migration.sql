-- T12535 (twin collapse, PR 2) — give `docs_attachments` the union shape of
-- the bare `attachments` table it replaces as the runtime table.
--
-- The bare table is the newer shape: T11875 added `display_alias` (the ADR
-- display number) and its index there, plus a partial index on `type`. The
-- twin gets the same column and indexes, so every bare row carries over
-- unchanged. The column is nullable, so existing twin rows need no default.
--
-- The bare table's two UNIQUE indexes (`slug` WHERE NOT NULL, `sha256`) are
-- NOT created here: a frozen twin copy could hold duplicates, and this
-- migration runs before the collapse removes them. The collapse drops and
-- re-creates them around every merge, inside its transaction
-- (store/twin-collapse.ts, `uniqueIndexes` of the ATTACHMENTS pair).
--
-- @task T12535

ALTER TABLE `docs_attachments` ADD COLUMN `display_alias` integer;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_docs_attachments_display_alias` ON `docs_attachments` (`display_alias`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_docs_attachments_type` ON `docs_attachments` (`type`) WHERE `type` IS NOT NULL;
