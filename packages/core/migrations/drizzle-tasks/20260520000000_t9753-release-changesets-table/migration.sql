-- T9753: Add `release_changesets` persistence table for CLEO-native
-- task-anchored changesets (T9738 carryforward).
--
-- Each row records one `.changeset/*.md` entry that was aggregated into the
-- corresponding release. `cleo release plan` reads `.changeset/*.md`, parses
-- them via `parseChangesetDir`, persists one row per entry here, and then
-- aggregates them into the CHANGELOG markdown section embedded into the
-- release plan envelope.
--
-- This table is the persistent audit trail of which entries shipped under
-- which release — once a release is published, the corresponding rows here
-- become an immutable record of the user-facing change inventory.
--
-- Differs from `release_changes` (T9508): release_changes is the editorial
-- CHANGELOG bucket derived from commit-level analysis and is per-bullet
-- granular. release_changesets is the upstream-entry source — one row per
-- `.changeset/*.md` file, carrying the structured frontmatter as-is so
-- downstream renderers can re-aggregate without re-reading the markdown.
--
-- task_ids: JSON array (one entry per CLEO task ID anchored by the changeset).
-- prs:      JSON array of integer PR numbers, nullable.
-- notes:    longer-form markdown body from the entry, nullable.
-- breaking: migration note when kind='breaking', nullable.
--
-- FKs:
--   release_id → releases(id) ON DELETE CASCADE
--
-- @task T9753
-- @epic T9752

CREATE TABLE IF NOT EXISTS `release_changesets` (
  `id`             TEXT PRIMARY KEY NOT NULL,
  `release_id`     TEXT NOT NULL REFERENCES `releases`(`id`) ON DELETE CASCADE,
  `changeset_id`   TEXT NOT NULL,
  `task_ids`       TEXT NOT NULL,
  `kind`           TEXT NOT NULL,
  `summary`        TEXT NOT NULL,
  `prs`            TEXT,
  `notes`          TEXT,
  `breaking`       TEXT,
  `created_at`     TEXT NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `release_changesets_release_id_idx`
  ON `release_changesets` (`release_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `release_changesets_changeset_id_idx`
  ON `release_changesets` (`changeset_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `release_changesets_kind_idx`
  ON `release_changesets` (`kind`);
