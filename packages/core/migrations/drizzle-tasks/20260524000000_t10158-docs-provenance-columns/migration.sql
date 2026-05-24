-- T10158 — Extend `attachments` with 7 docs-provenance columns mirroring
-- the proven supersession + classification pattern already shipped on
-- `brain_decisions` by T1826 (see
-- `packages/core/migrations/drizzle-brain/20260504000001_t1826-decisions-v2/migration.sql`).
--
-- Additive + forward-only: every new column is nullable or carries a
-- safe DEFAULT, so SQLite ALTER TABLE ADD COLUMN does NOT rewrite the
-- table and existing rows pass through with nulls / defaults. No data
-- migration of legacy rows is required for this slice — downstream
-- writers (T10162 supersede verb, T10164 graph CLI, etc.) populate the
-- columns going forward.
--
-- Columns introduced:
--   1. lifecycle_status TEXT NOT NULL DEFAULT 'draft'
--        Document workflow state mirroring brain_decisions.confirmation_state.
--        Allowed values (enforced at the dispatch layer, not via CHECK so
--        future additions don't require a schema migration):
--          draft | proposed | accepted | superseded | archived | deprecated
--   2. supersedes      TEXT REFERENCES attachments(id)
--        Self-FK to the attachment ID this doc replaces (forward pointer).
--   3. superseded_by   TEXT REFERENCES attachments(id)
--        Self-FK reverse pointer — set when a newer doc supersedes this one.
--   4. summary         TEXT
--        Short human-readable summary (≤ 1 sentence), distinct from the
--        full body stored in attachment_json.
--   5. keywords        TEXT
--        JSON array of free-form keyword strings for search.
--   6. topics          TEXT
--        JSON array of canonical topic slugs (cross-cuts taxonomy).
--   7. related_tasks   TEXT
--        JSON array of T#### task IDs that this doc relates to.
--
-- Indices:
--   - idx_attachments_lifecycle_status — graph filtering by lifecycle
--   - idx_attachments_supersedes       — graph traversal (forward edges)
--
-- DEPENDS ON: 20260416000000_t796-attachments (creates `attachments`)
-- SAFE FOR:   SQLite 3.35+ (ALTER TABLE ADD COLUMN with DEFAULT is atomic)
--
-- @task T10158
-- @epic T10157 (C-DOCS-SSOT)
-- @saga T9855 (SG-TEMPLATE-CONFIG-SSOT)
-- @adr  ADR-078

ALTER TABLE `attachments` ADD COLUMN `lifecycle_status` text NOT NULL DEFAULT 'draft';
--> statement-breakpoint
ALTER TABLE `attachments` ADD COLUMN `supersedes` text REFERENCES `attachments`(`id`);
--> statement-breakpoint
ALTER TABLE `attachments` ADD COLUMN `superseded_by` text REFERENCES `attachments`(`id`);
--> statement-breakpoint
ALTER TABLE `attachments` ADD COLUMN `summary` text;
--> statement-breakpoint
ALTER TABLE `attachments` ADD COLUMN `keywords` text;
--> statement-breakpoint
ALTER TABLE `attachments` ADD COLUMN `topics` text;
--> statement-breakpoint
ALTER TABLE `attachments` ADD COLUMN `related_tasks` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_attachments_lifecycle_status`
  ON `attachments` (`lifecycle_status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_attachments_supersedes`
  ON `attachments` (`supersedes`)
  WHERE `supersedes` IS NOT NULL;
