-- T9506 (2/4): Add `task_commits` table for provenance graph (ADR-073 / SPEC-T9345 §3.2).
--
-- M:N junction between tasks and commits. Each row records one typed linkage edge:
--   task_id    → the CLEO task that a commit relates to
--   commit_sha → the git commit SHA (FK → commits.sha)
--   link_kind  → semantic classification (implements/fixes/refactors/tests/docs/reverts)
--   link_source → how the link was discovered (commit-trailer/commit-subject/pr-title/
--                 pr-body/branch-name/manual)
--
-- Composite PK (task_id, commit_sha, link_kind) permits a single commit to be linked
-- to a single task via multiple relationship types (e.g., both 'implements' and 'tests').
--
-- FK task_id uses ON DELETE SET NULL (not CASCADE) to preserve commit linkage history
-- even if the task is deleted — provenance graph must not lose edges on task purge.
-- FK commit_sha uses ON DELETE CASCADE — if a commit is purged, its junction rows go too.
--
-- @task T9506
-- @epic T9491

CREATE TABLE `task_commits` (
  `task_id`    TEXT REFERENCES `tasks`(`id`) ON DELETE SET NULL,
  `commit_sha` TEXT NOT NULL REFERENCES `commits`(`sha`) ON DELETE CASCADE,
  `link_kind`  TEXT NOT NULL,
  `link_source` TEXT NOT NULL,
  `created_at` TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (`task_id`, `commit_sha`, `link_kind`)
);
--> statement-breakpoint

CREATE INDEX `idx_task_commits_task_id` ON `task_commits` (`task_id`);
--> statement-breakpoint
CREATE INDEX `idx_task_commits_commit_sha` ON `task_commits` (`commit_sha`);
--> statement-breakpoint
CREATE INDEX `idx_task_commits_link_kind` ON `task_commits` (`link_kind`);
