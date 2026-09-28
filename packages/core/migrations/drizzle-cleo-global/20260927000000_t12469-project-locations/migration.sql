-- T12469 — the project registry is keyed by project_id ALONE (ADR-094), and
-- every place a project has been seen, on every device, is a row in the new
-- `nexus_project_locations` table (drizzle-cleo-global scope ONLY).
--
-- ## 1. Registry rebuild: no UNIQUE on any path or path hash
--
-- The consolidation baseline created `nexus_project_registry.project_path` as
-- `NOT NULL UNIQUE`, which made a path an identity: a second checkout, or a
-- directory whose project-id changed, could not be represented. SQLite cannot
-- drop a column constraint in place, so the table is rebuilt with the standard
-- idiom (create `_new`, copy every row, drop, rename) and its indexes are
-- recreated. The column set, defaults and CHECK are unchanged; every row is
-- copied verbatim. `project_hash` was never physically UNIQUE (only the
-- drizzle declaration said so); it keeps its plain index. A plain index on
-- `project_path` keeps path lookups indexed now that the UNIQUE autoindex is
-- gone. No trigger, view or FK references this table.
--
-- ## 2. nexus_project_locations
--
-- PK (project_id, device_id, path); state live | missing | superseded. A
-- vanished directory is marked `missing`, never deleted.
--
-- Backfill: every `nexus_project_paths` row (the T12354 device-local path map)
-- and every registry row becomes a `live` location. The device id cannot be
-- computed in SQL, so backfilled rows carry the sentinel device id `local`;
-- this store is device-local, so every such row belongs to this device, and
-- the runtime (`adoptLocalDeviceRows` in nexus/path-map.ts) re-keys them to the
-- stable device id on first write. Liveness cannot be checked in SQL either:
-- the runtime marks a vanished backfilled path `missing` the next time its
-- project is recorded. A timestamp that would fail the ISO-8601 CHECK is
-- replaced with the migration instant rather than letting OR IGNORE drop the
-- row, so no location is lost.
--
-- `nexus_project_paths` and `nexus_project_id_aliases` are left untouched —
-- older binaries sharing this global store still read the path map, and
-- aliases are not affected by this change.
--
-- ## Page-2 invariant
--
-- Runs long after the consolidation baseline, so no journal pre-create is
-- required. Statements are separated by drizzle breakpoint marker lines so
-- node:sqlite prepare() does not truncate the file to statement one (the
-- marker token is intentionally not spelled out in this comment — drizzle's
-- readMigrationFiles splits the file on that literal substring).
--
-- @task T12469
-- @adr ADR-094

CREATE TABLE `nexus_project_registry_t12469_new` (
	`project_id` text PRIMARY KEY,
	`project_hash` text NOT NULL,
	`project_path` text NOT NULL,
	`name` text NOT NULL,
	`registered_at` text DEFAULT (datetime('now')) NOT NULL,
	`last_seen` text DEFAULT (datetime('now')) NOT NULL,
	`health_status` text DEFAULT 'unknown' NOT NULL,
	`health_last_check` text,
	`permissions` text DEFAULT 'read' NOT NULL,
	`last_sync` text DEFAULT (datetime('now')) NOT NULL,
	`task_count` integer DEFAULT 0 NOT NULL,
	`labels_json` text DEFAULT '[]' NOT NULL,
	`brain_db_path` text,
	`tasks_db_path` text,
	`last_indexed` text,
	`stats_json` text DEFAULT '{}' NOT NULL,
	CHECK ("registered_at" IS NULL OR "registered_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
INSERT INTO `nexus_project_registry_t12469_new` (
	`project_id`, `project_hash`, `project_path`, `name`, `registered_at`, `last_seen`,
	`health_status`, `health_last_check`, `permissions`, `last_sync`, `task_count`,
	`labels_json`, `brain_db_path`, `tasks_db_path`, `last_indexed`, `stats_json`
)
SELECT
	`project_id`, `project_hash`, `project_path`, `name`, `registered_at`, `last_seen`,
	`health_status`, `health_last_check`, `permissions`, `last_sync`, `task_count`,
	`labels_json`, `brain_db_path`, `tasks_db_path`, `last_indexed`, `stats_json`
FROM `nexus_project_registry`;
--> statement-breakpoint
DROP TABLE `nexus_project_registry`;
--> statement-breakpoint
ALTER TABLE `nexus_project_registry_t12469_new` RENAME TO `nexus_project_registry`;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_nexus_project_registry_hash` ON `nexus_project_registry` (`project_hash`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_nexus_project_registry_path` ON `nexus_project_registry` (`project_path`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_nexus_project_registry_health` ON `nexus_project_registry` (`health_status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_nexus_project_registry_name` ON `nexus_project_registry` (`name`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_nexus_project_registry_last_indexed` ON `nexus_project_registry` (`last_indexed`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `nexus_project_locations` (
	`project_id` text NOT NULL,
	`device_id` text NOT NULL,
	`path` text NOT NULL,
	`first_seen` text NOT NULL DEFAULT (datetime('now')),
	`last_seen` text NOT NULL DEFAULT (datetime('now')),
	`state` text NOT NULL DEFAULT 'live',
	PRIMARY KEY (`project_id`, `device_id`, `path`),
	CHECK ("state" IN ('live', 'missing', 'superseded')),
	CHECK ("first_seen" IS NULL OR "first_seen" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("last_seen" IS NULL OR "last_seen" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_nexus_project_locations_device_path` ON `nexus_project_locations` (`device_id`, `path`);
--> statement-breakpoint
INSERT OR IGNORE INTO `nexus_project_locations` (`project_id`, `device_id`, `path`, `first_seen`, `last_seen`, `state`)
SELECT `project_id`, 'local', `project_path`,
	CASE WHEN `first_seen` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN `first_seen` ELSE datetime('now') END,
	CASE WHEN `last_seen` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN `last_seen` ELSE datetime('now') END,
	'live'
FROM `nexus_project_paths`;
--> statement-breakpoint
INSERT OR IGNORE INTO `nexus_project_locations` (`project_id`, `device_id`, `path`, `first_seen`, `last_seen`, `state`)
SELECT `project_id`, 'local', `project_path`,
	CASE WHEN `registered_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN `registered_at` ELSE datetime('now') END,
	CASE WHEN `last_seen` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN `last_seen` ELSE datetime('now') END,
	'live'
FROM `nexus_project_registry`;
