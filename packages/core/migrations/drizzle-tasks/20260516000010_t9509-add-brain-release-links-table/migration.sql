-- T9509 (2/2): Add `brain_release_links` M:N junction table that closes the
-- BRAIN↔release loop (ADR-073 / SPEC-T9345 §8).
--
-- Links BRAIN entries (decisions, observations, patterns, learnings) to releases
-- so that questions like "Which decisions approved the fix in v2026.5.74?" or
-- "Which release first documented this pattern?" are SQL-answerable.
--
-- Cross-DB soft FK strategy (§8.2):
--   `brain_entry_id` references a row in brain.db (a separate SQLite file).
--   A hard REFERENCES constraint is intentionally omitted because SQLite cannot
--   enforce cross-file foreign keys. The access-layer (BrainAccessor +
--   DataAccessor) coordinates referential integrity at runtime per the existing
--   cross-DB pattern in packages/core/src/store/brain-accessor-impl.ts.
--   ON DELETE SET NULL semantics are preserved at the application layer.
--
-- `release_id` carries a hard FK to releases(id) in the same file (tasks.db).
-- ON DELETE CASCADE: purging a release removes all its brain link rows.
--
-- Composite PRIMARY KEY: (brain_entry_id, release_id, link_type).
-- Multiple link_type values between the same (brain_entry_id, release_id) pair
-- are valid — a decision can both "approve" and "document" the same release.
--
-- @task T9509
-- @epic T9491
-- @see SPEC-T9345 §8.1

CREATE TABLE `brain_release_links` (
  `brain_entry_id` TEXT,
  `release_id`     TEXT NOT NULL REFERENCES `releases`(`id`) ON DELETE CASCADE,
  `link_type`      TEXT NOT NULL,
  `created_at`     TEXT NOT NULL DEFAULT (datetime('now')),
  `created_by`     TEXT,
  PRIMARY KEY (`brain_entry_id`, `release_id`, `link_type`)
);
--> statement-breakpoint

CREATE INDEX `idx_brain_release_links_brain_entry_id` ON `brain_release_links` (`brain_entry_id`);
--> statement-breakpoint
CREATE INDEX `idx_brain_release_links_release_id` ON `brain_release_links` (`release_id`);
--> statement-breakpoint
CREATE INDEX `idx_brain_release_links_link_type` ON `brain_release_links` (`link_type`);
