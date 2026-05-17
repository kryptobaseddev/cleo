-- T9506 (1/4): Add `commits` table for provenance graph (ADR-073 / SPEC-T9345 §3.1).
--
-- Captures every git commit reachable from a release tag. Stores identity, author
-- attribution, Conventional Commits classification, and project correlation so that
-- SQL queries can answer "which commits shipped in release vX.Y.Z?" without shelling
-- out to git at query time.
--
-- New edges enabled:
--   commit → release  (via release_commits junction — shipped in 2/4)
--   commit → task     (via task_commits junction — shipped in 2/4)
--   commit → file     (via commit_files — shipped in 3/4)
--
-- All columns use SQLite-idiomatic types: TEXT for strings + ISO-8601 timestamps,
-- INTEGER for booleans (0/1), NULL for truly optional fields.
--
-- @task T9506
-- @epic T9491

CREATE TABLE `commits` (
  `sha`                TEXT PRIMARY KEY NOT NULL,
  `short_sha`          TEXT NOT NULL,
  `author_name`        TEXT,
  `author_email`       TEXT,
  `authored_at`        TEXT NOT NULL,
  `committer_name`     TEXT,
  `committer_email`    TEXT,
  `committed_at`       TEXT NOT NULL,
  `message`            TEXT NOT NULL,
  `subject`            TEXT NOT NULL,
  `conventional_type`  TEXT,
  `is_release_commit`  INTEGER NOT NULL DEFAULT 0,
  `is_merge_commit`    INTEGER NOT NULL DEFAULT 0,
  `parent_shas`        TEXT NOT NULL DEFAULT '[]',
  `signature_verified` INTEGER,
  `branch_at_commit`   TEXT,
  `project_hash`       TEXT,
  `created_at`         TEXT NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint

CREATE INDEX `idx_commits_short_sha` ON `commits` (`short_sha`);
--> statement-breakpoint
CREATE INDEX `idx_commits_author_email` ON `commits` (`author_email`);
--> statement-breakpoint
CREATE INDEX `idx_commits_authored_at` ON `commits` (`authored_at`);
--> statement-breakpoint
CREATE INDEX `idx_commits_conventional_type` ON `commits` (`conventional_type`);
--> statement-breakpoint
CREATE INDEX `idx_commits_is_release` ON `commits` (`is_release_commit`);
--> statement-breakpoint
CREATE INDEX `idx_commits_project_hash` ON `commits` (`project_hash`);
