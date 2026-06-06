-- T11875 — give ADR display-aliases real storage DECOUPLED from the slug.
--
-- Background (ADR reconcile T11676 · ratified slug-primary model, saga T11778):
--   Under the slug-primary model the kebab `slug` is the canonical handle and
--   the displayed number (e.g. ADR "051") is a DISPLAY ALIAS only. Until now
--   that number was DERIVED by parsing the digits out of the slug string
--   (`adr-051-*` → 051), so three DISTINCT ADRs that all slug as `adr-051-*`
--   (override-patterns ≠ programmatic-gate-integrity ≠ worktree-extension)
--   rendered the same "051" with no way to disambiguate. The collision cannot
--   be resolved by renumbering a slug (that would break the canonical handle).
--
--   This migration adds a real, nullable `display_alias` INTEGER column to
--   `attachments` so a doc can carry an explicit display number independent of
--   its slug. `numbering.ts::resolveDisplayNumber` PREFERS the stored alias
--   when present and falls back to the slug-derived number when null — so docs
--   that never get an alias keep their historical rendering byte-for-byte.
--
--   Uniqueness among `type='adr'` docs is enforced at the DISPATCH layer
--   (`display-alias.ts::setDisplayAlias`), NOT via a SQL UNIQUE constraint:
--   the constraint is scoped to one kind, and dispatch-validation matches the
--   discipline already used for `lifecycle_status` / `docs_wikilinks.relation`
--   so future taxonomy changes never require another schema migration.
--
-- Additive + forward-only: the new column is nullable, so SQLite ALTER TABLE
-- ADD COLUMN does NOT rewrite the table and existing rows pass through with
-- NULL (i.e. "no alias — derive from slug"). No data migration of legacy rows
-- is required; the `cleo docs set-alias` verb populates aliases going forward.
--
-- Changes (idempotent — safe to re-run):
--   1. ALTER TABLE attachments ADD COLUMN display_alias integer  (nullable).
--   2. CREATE INDEX idx_attachments_display_alias — speeds the per-type
--      uniqueness scan performed by setDisplayAlias.
--
-- DEPENDS ON: 20260416000000_t796-attachments (creates `attachments`)
-- SAFE FOR:   SQLite 3.35+ (ALTER TABLE ADD COLUMN nullable is atomic)
--
-- @task T11875
-- @epic T11781 (E3-OBSIDIAN-INTEGRATION)
-- @saga T11778 (SG-DOCS-SSOT-VAULT)
-- @closes (display-alias half of) T11676 ADR reconcile plan

ALTER TABLE `attachments` ADD COLUMN `display_alias` integer;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_attachments_display_alias`
  ON `attachments` (`display_alias`);
