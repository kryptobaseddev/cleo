-- T9507 (3/3): Add `pr_tasks` table for provenance graph (ADR-073 / SPEC-T9345 §3.5).
--
-- M:N junction between pull_requests and tasks. Each row records one typed link
-- between a PR and a CLEO task, including how the link was discovered (link_source)
-- and the semantic relationship kind (link_kind).
--
-- Composite PK (pr_id, task_id, link_kind) allows a PR to be linked to the same
-- task via multiple relationship types (e.g., both 'implements' and 'fixes').
--
-- FK pr_id uses ON DELETE CASCADE — if a PR is purged its task links go too.
-- FK task_id uses ON DELETE SET NULL — if a task is purged the PR audit trail
-- is preserved (orphaned link with task_id = NULL).
--
-- link_kind reuses PR_LINK_KINDS (which extends COMMIT_LINK_KINDS + 'tracks').
-- link_source reuses PR_LINK_SOURCES for symmetry with task_commits.link_source.
--
-- @task T9507
-- @epic T9491

CREATE TABLE `pr_tasks` (
  `pr_id`       TEXT NOT NULL REFERENCES `pull_requests`(`id`) ON DELETE CASCADE,
  `task_id`     TEXT REFERENCES `tasks`(`id`) ON DELETE SET NULL,
  `link_source` TEXT NOT NULL,
  `link_kind`   TEXT NOT NULL,
  `created_at`  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (`pr_id`, `task_id`, `link_kind`)
);
--> statement-breakpoint

CREATE INDEX `idx_pr_tasks_pr_id` ON `pr_tasks` (`pr_id`);
--> statement-breakpoint
CREATE INDEX `idx_pr_tasks_task_id` ON `pr_tasks` (`task_id`);
--> statement-breakpoint
CREATE INDEX `idx_pr_tasks_link_source` ON `pr_tasks` (`link_source`);
