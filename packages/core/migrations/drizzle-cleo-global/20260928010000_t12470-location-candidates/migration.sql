-- T12470 — a checkout that merely DECLARES an existing project id is a
-- `candidate` location, never a live one (drizzle-cleo-global scope ONLY).
--
-- `.cleo/project-id` is committed to git (ADR-094), so any directory can
-- declare any project's id. The state set gains `candidate`: a location seen
-- but not confirmed. Only an explicit command (`cleo init`, `cleo nexus
-- register`, `cleo doctor project-identity --resolve`) or a proven move
-- promotes it.
--
-- Three nullable columns:
--   `checkout_nonce`  — random per-checkout secret kept in the checkout's
--                       UNTRACKED `.cleo/project-info.json`. A real move or a
--                       restore of `.cleo/` carries it; a clone cannot. The
--                       ONLY evidence that proves a move.
--   `git_root_commit` — first (parentless) commit; displayed evidence only.
--   `git_remote`      — normalised `origin` URL; displayed evidence only.
--
-- ## Detectability (why ADD COLUMN comes first)
--
-- The journal reconciler marks an un-journaled migration applied when its DDL
-- targets already exist. A pure rebuild's only target is the final table name,
-- which every T12469 store already has — so a rebuild-only migration would be
-- journaled WITHOUT running. The three `ADD COLUMN` statements are the probe
-- targets: on a T12469 store they are missing, so this migration runs. Drizzle
-- applies a migration inside one transaction, so the columns and the rebuilt
-- CHECK below land together or not at all.
--
-- SQLite cannot alter a CHECK in place, so after the columns are added the
-- table is rebuilt (create `_new`, copy every row verbatim, drop, rename) and
-- its index recreated.
--
-- Statements are separated by drizzle breakpoint marker lines (the literal
-- token is not spelled out here; drizzle's readMigrationFiles splits on it).
--
-- @task T12470
-- @adr ADR-094

ALTER TABLE `nexus_project_locations` ADD COLUMN `checkout_nonce` text;
--> statement-breakpoint
ALTER TABLE `nexus_project_locations` ADD COLUMN `git_root_commit` text;
--> statement-breakpoint
ALTER TABLE `nexus_project_locations` ADD COLUMN `git_remote` text;
--> statement-breakpoint
CREATE TABLE `nexus_project_locations_t12470_new` (
	`project_id` text NOT NULL,
	`device_id` text NOT NULL,
	`path` text NOT NULL,
	`first_seen` text NOT NULL DEFAULT (datetime('now')),
	`last_seen` text NOT NULL DEFAULT (datetime('now')),
	`state` text NOT NULL DEFAULT 'live',
	`checkout_nonce` text,
	`git_root_commit` text,
	`git_remote` text,
	PRIMARY KEY (`project_id`, `device_id`, `path`),
	CHECK ("state" IN ('live', 'missing', 'superseded', 'candidate')),
	CHECK ("first_seen" IS NULL OR "first_seen" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("last_seen" IS NULL OR "last_seen" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
INSERT INTO `nexus_project_locations_t12470_new` (
	`project_id`, `device_id`, `path`, `first_seen`, `last_seen`, `state`,
	`checkout_nonce`, `git_root_commit`, `git_remote`
)
SELECT `project_id`, `device_id`, `path`, `first_seen`, `last_seen`, `state`,
	`checkout_nonce`, `git_root_commit`, `git_remote`
FROM `nexus_project_locations`;
--> statement-breakpoint
DROP TABLE `nexus_project_locations`;
--> statement-breakpoint
ALTER TABLE `nexus_project_locations_t12470_new` RENAME TO `nexus_project_locations`;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_nexus_project_locations_device_path` ON `nexus_project_locations` (`device_id`, `path`);
