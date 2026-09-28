-- T12470 — a checkout that merely DECLARES an existing project id is a
-- `candidate` location, never a live one (drizzle-cleo-global scope ONLY).
--
-- `.cleo/project-id` is committed to git (ADR-094), so any directory can
-- declare any project's id: a clone, a fork, or a hostile copy of the file.
-- Before this migration the per-command encounter bound such a directory as
-- the project's live location and repointed its registry row (with its
-- permissions) to it. The state set gains `candidate`: a location seen but not
-- confirmed. Only an explicit command (`cleo init`, `cleo nexus register`,
-- `cleo doctor project-identity --resolve`) or a verified move promotes it.
--
-- Two nullable evidence columns record what a confirmed checkout looked like,
-- so a move can be verified after the old directory is gone:
--   `git_root_commit` — the repository's first (parentless) commit
--   `git_remote`      — the normalised `origin` URL
-- Existing rows carry NULL evidence; a NULL never matches, so a location
-- without evidence can only be promoted explicitly.
--
-- SQLite cannot alter a CHECK in place, so the table is rebuilt (create
-- `_new`, copy every row verbatim, drop, rename) and its index recreated.
--
-- Statements are separated by drizzle breakpoint marker lines (the literal
-- token is not spelled out here; drizzle's readMigrationFiles splits on it).
--
-- @task T12470
-- @adr ADR-094

CREATE TABLE `nexus_project_locations_t12470_new` (
	`project_id` text NOT NULL,
	`device_id` text NOT NULL,
	`path` text NOT NULL,
	`first_seen` text NOT NULL DEFAULT (datetime('now')),
	`last_seen` text NOT NULL DEFAULT (datetime('now')),
	`state` text NOT NULL DEFAULT 'live',
	`git_root_commit` text,
	`git_remote` text,
	PRIMARY KEY (`project_id`, `device_id`, `path`),
	CHECK ("state" IN ('live', 'missing', 'superseded', 'candidate')),
	CHECK ("first_seen" IS NULL OR "first_seen" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("last_seen" IS NULL OR "last_seen" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
INSERT INTO `nexus_project_locations_t12470_new` (
	`project_id`, `device_id`, `path`, `first_seen`, `last_seen`, `state`
)
SELECT `project_id`, `device_id`, `path`, `first_seen`, `last_seen`, `state`
FROM `nexus_project_locations`;
--> statement-breakpoint
DROP TABLE `nexus_project_locations`;
--> statement-breakpoint
ALTER TABLE `nexus_project_locations_t12470_new` RENAME TO `nexus_project_locations`;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_nexus_project_locations_device_path` ON `nexus_project_locations` (`device_id`, `path`);
