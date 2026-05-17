-- T9508 (2/3): Add `release_commits` junction table (ADR-073 / SPEC-T9345 §3.8).
--
-- M:N junction between releases and commits. Each row records one commit that
-- belongs to a given release range (derived from `git log <prev_tag>..<tag>`).
--
-- position: topo-sorted ascending (0 = oldest commit, N = newest / tag commit).
-- is_first: 1 for the first commit after the previous release boundary.
-- is_last:  1 for the tag/merge commit that closed this release.
-- is_release_chore: 1 for "chore(release): vX.Y.Z" version-bump commits.
--
-- Mutual-exclusivity note: is_first, is_last, and is_release_chore are logically
-- mutually exclusive — a given commit should be at most one of these roles.
-- The constraint is enforced at the application layer (see TSDoc on the schema)
-- because SQLite CHECK with multi-column logic is verbose. Parity tests validate
-- the invariant.
--
-- FKs:
--   release_id  → releases(id)      ON DELETE CASCADE
--   commit_sha  → commits(sha)       ON DELETE CASCADE
--
-- @task T9508
-- @epic T9491

CREATE TABLE `release_commits` (
  `release_id`        TEXT NOT NULL REFERENCES `releases`(`id`) ON DELETE CASCADE,
  `commit_sha`        TEXT NOT NULL REFERENCES `commits`(`sha`) ON DELETE CASCADE,
  `position`          INTEGER NOT NULL,
  `is_first`          INTEGER NOT NULL DEFAULT 0,
  `is_last`           INTEGER NOT NULL DEFAULT 0,
  `is_release_chore`  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (`release_id`, `commit_sha`)
);
--> statement-breakpoint

CREATE INDEX `idx_release_commits_release_id` ON `release_commits` (`release_id`);
--> statement-breakpoint
CREATE INDEX `idx_release_commits_commit_sha` ON `release_commits` (`commit_sha`);
--> statement-breakpoint
CREATE INDEX `idx_release_commits_position` ON `release_commits` (`release_id`, `position`);
