-- T9636 / T9637 — Add `slug` and `type` columns to `attachments` table.
--
-- Background: prior to this migration, attachments could only be addressed by
-- their generated `att_<base62>` ID or by full / prefix SHA-256. Operators
-- writing docs at the command line want short, human-friendly aliases — and
-- a coarse classification axis to filter by intent (spec / adr / research /
-- handoff / note / llm-readme).
--
-- Schema decision (Option B, per Epic T9627 design guidance): the legacy
-- `attachments` table has no `projectId` column because tasks.db is itself
-- per-project. Slug uniqueness is therefore enforced via a PARTIAL UNIQUE
-- INDEX on (slug) WHERE slug IS NOT NULL. Rows without a slug remain
-- non-unique (multiple attachments without a slug are allowed).
--
-- Backward compatibility:
--   - Both columns are nullable. Existing rows pass-through with NULL slug
--     and NULL type, so `cleo docs fetch <att_id>` and SHA-256-prefix lookup
--     paths continue to work unchanged.
--   - The `type` column does NOT carry a CHECK constraint: validation happens
--     at the dispatch layer so future taxonomy additions don't require a
--     schema migration.
--
-- @task T9636 (T-DOCS-SLUG-1 — slug column + uniqueness + collision suggestions)
-- @task T9637 (T-DOCS-SLUG-2 — type taxonomy column)
-- @epic T9627 (E-DOCS-SLUG-CLASSIFY)
-- @saga T9625

ALTER TABLE `attachments` ADD COLUMN `slug` text;
--> statement-breakpoint
ALTER TABLE `attachments` ADD COLUMN `type` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_attachments_slug` ON `attachments` (`slug`) WHERE `slug` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_attachments_type` ON `attachments` (`type`) WHERE `type` IS NOT NULL;
