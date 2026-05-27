-- T9507 (1/3): Add `pull_requests` table for provenance graph (ADR-073 / SPEC-T9345 §3.4).
--
-- Captures PR identity, lifecycle, and CI state so that the release provenance graph can
-- answer "which PRs shipped in vX.Y.Z?" and "which tasks did PR #185 implement?"
-- without shelling out to the GitHub API at query time.
--
-- ID format: "<projectHash>:<prNumber>" — unique per CLEO project, avoids collision
-- across forks/repos in multi-project installs.
--
-- head_sha and merge_commit_sha are soft FKs to commits.sha (ON DELETE SET NULL) so
-- that a commit purge does not cascade-delete PR records — the PR audit trail is
-- independently valuable.
--
-- is_release_pr / is_bump_only are INTEGER booleans (0/1) per SQLite idiom.
-- All timestamps use TEXT (ISO-8601) to match tasks-schema.ts convention.
--
-- New edges enabled:
--   pull_request → commit  (via pr_commits junction — shipped in 2/3)
--   pull_request → task    (via pr_tasks junction — shipped in 3/3)
--
-- @task T9507
-- @epic T9491

CREATE TABLE `pull_requests` (
  `id`                TEXT PRIMARY KEY NOT NULL,
  `pr_number`         INTEGER NOT NULL,
  `repo_url`          TEXT NOT NULL,
  `title`             TEXT NOT NULL,
  `body`              TEXT,
  `state`             TEXT NOT NULL,
  `base_ref`          TEXT NOT NULL,
  `head_ref`          TEXT NOT NULL,
  `head_sha`          TEXT REFERENCES `commits`(`sha`) ON DELETE SET NULL,
  `merge_commit_sha`  TEXT REFERENCES `commits`(`sha`) ON DELETE SET NULL,
  `author_login`      TEXT,
  `opened_at`         TEXT NOT NULL,
  `merged_at`         TEXT,
  `closed_at`         TEXT,
  `is_release_pr`     INTEGER NOT NULL DEFAULT 0,
  `release_version`   TEXT,
  `is_bump_only`      INTEGER NOT NULL DEFAULT 0,
  `project_hash`      TEXT,
  `created_at`        TEXT NOT NULL DEFAULT (datetime('now')),
  `updated_at`        TEXT NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint

CREATE INDEX `idx_pr_number` ON `pull_requests` (`pr_number`);
--> statement-breakpoint
CREATE INDEX `idx_pr_state` ON `pull_requests` (`state`);
--> statement-breakpoint
CREATE INDEX `idx_pr_merge_commit_sha` ON `pull_requests` (`merge_commit_sha`);
--> statement-breakpoint
CREATE INDEX `idx_pr_head_sha` ON `pull_requests` (`head_sha`);
--> statement-breakpoint
CREATE INDEX `idx_pr_release_version` ON `pull_requests` (`release_version`);
--> statement-breakpoint
CREATE INDEX `idx_pr_project_hash` ON `pull_requests` (`project_hash`);
