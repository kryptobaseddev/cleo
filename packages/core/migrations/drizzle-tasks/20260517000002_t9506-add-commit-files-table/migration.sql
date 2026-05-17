-- T9506 (3/4): Add `commit_files` table for provenance graph (ADR-073 / SPEC-T9345 §3.3).
--
-- Per-file × SHA materialization. Every (commit_sha, path) pair has one row describing
-- the type of change (added/modified/deleted/renamed/copied), diff stats, and whether
-- the file is binary.
--
-- Enables blast-radius queries:
--   "Which tasks last touched packages/core/src/release/engine-ops.ts?" →
--     SELECT t.id FROM commit_files cf
--     JOIN task_commits tc ON tc.commit_sha = cf.commit_sha
--     JOIN tasks t ON t.id = tc.task_id
--     WHERE cf.path = 'packages/core/src/release/engine-ops.ts'
--
-- change_type values mirror git status letters:
--   A = added, M = modified, D = deleted, R = renamed, C = copied
--
-- old_path is non-NULL only for R (rename) and C (copy) — records the source path.
--
-- FK commit_sha uses ON DELETE CASCADE — if a commit is purged, its file rows go too.
-- Composite PK (commit_sha, path) is unique per commit: one row per file per commit.
--
-- @task T9506
-- @epic T9491

CREATE TABLE `commit_files` (
  `commit_sha`  TEXT NOT NULL REFERENCES `commits`(`sha`) ON DELETE CASCADE,
  `path`        TEXT NOT NULL,
  `old_path`    TEXT,
  `change_type` TEXT NOT NULL,
  `lines_added` INTEGER NOT NULL DEFAULT 0,
  `lines_deleted` INTEGER NOT NULL DEFAULT 0,
  `is_binary`   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (`commit_sha`, `path`)
);
--> statement-breakpoint

CREATE INDEX `idx_commit_files_path` ON `commit_files` (`path`);
--> statement-breakpoint
CREATE INDEX `idx_commit_files_change_type` ON `commit_files` (`change_type`);
