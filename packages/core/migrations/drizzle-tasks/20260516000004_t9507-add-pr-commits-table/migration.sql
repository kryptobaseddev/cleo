-- T9507 (2/3): Add `pr_commits` table for provenance graph (ADR-073 / SPEC-T9345 §3.5).
--
-- M:N ordered junction between pull_requests and commits. Each row records one
-- commit that was part of a PR, along with its position (order) in the PR commit list.
--
-- Composite PK (pr_id, commit_sha) ensures a commit appears at most once per PR.
-- `position` records the ordinal position within the PR commit list (0-based or 1-based,
-- as populated by the ingestion agent).
--
-- FK pr_id uses ON DELETE CASCADE — if a PR is purged its commit links go too.
-- FK commit_sha uses ON DELETE CASCADE — if a commit is purged its PR links go too.
--
-- @task T9507
-- @epic T9491

CREATE TABLE `pr_commits` (
  `pr_id`      TEXT NOT NULL REFERENCES `pull_requests`(`id`) ON DELETE CASCADE,
  `commit_sha` TEXT NOT NULL REFERENCES `commits`(`sha`) ON DELETE CASCADE,
  `position`   INTEGER NOT NULL,
  PRIMARY KEY (`pr_id`, `commit_sha`)
);
--> statement-breakpoint

CREATE INDEX `idx_pr_commits_pr_id` ON `pr_commits` (`pr_id`);
--> statement-breakpoint
CREATE INDEX `idx_pr_commits_commit_sha` ON `pr_commits` (`commit_sha`);
--> statement-breakpoint
CREATE INDEX `idx_pr_commits_position` ON `pr_commits` (`pr_id`, `position`);
