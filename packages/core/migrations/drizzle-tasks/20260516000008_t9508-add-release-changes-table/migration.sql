-- T9508 (3/3): Add `release_changes` editorial/CHANGELOG table (ADR-073 / SPEC-T9345 §3.7).
--
-- The editorial layer for CHANGELOG generation. Each row corresponds to one bullet
-- in the rendered CHANGELOG for a release. A release with 10 features + 3 bugfixes
-- + 1 breaking change has 14 rows here.
--
-- change_type uses the CLEO 12-value taxonomy (Option B from §2.2 — orthogonal to
-- tasks.kind). Classification is:
--   auto      → derived from CC prefix + heuristics at write-time
--   manual    → owner overrode the auto classification
--   approved  → owner approved an agent-proposed classification
--
-- task_id uses ON DELETE SET NULL: some changes are not task-linked (e.g., a
-- dependency bump detected from commit diff analysis).
--
-- impact mirrors semver assessment:
--   major → BREAKING CHANGE (release_kind='major' or is_breaking=1)
--   minor → new feature
--   patch → bug fix / chore
--   none  → cosmetic / docs / trivial
--
-- summary is limited to 200 characters (enforced at application layer; parity test).
--
-- FKs:
--   release_id  → releases(id)  ON DELETE CASCADE
--   task_id     → tasks(id)     ON DELETE SET NULL
--
-- @task T9508
-- @epic T9491

CREATE TABLE `release_changes` (
  `id`              TEXT PRIMARY KEY NOT NULL,
  `release_id`      TEXT NOT NULL REFERENCES `releases`(`id`) ON DELETE CASCADE,
  `task_id`         TEXT REFERENCES `tasks`(`id`) ON DELETE SET NULL,
  `change_type`     TEXT NOT NULL,
  `summary`         TEXT NOT NULL,
  `description`     TEXT,
  `impact`          TEXT NOT NULL DEFAULT 'patch',
  `classified_by`   TEXT NOT NULL DEFAULT 'auto',
  `classified_at`   TEXT NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint

CREATE INDEX `idx_release_changes_release_id` ON `release_changes` (`release_id`);
--> statement-breakpoint
CREATE INDEX `idx_release_changes_task_id` ON `release_changes` (`task_id`);
--> statement-breakpoint
CREATE INDEX `idx_release_changes_change_type` ON `release_changes` (`change_type`);
--> statement-breakpoint
CREATE INDEX `idx_release_changes_impact` ON `release_changes` (`impact`);
