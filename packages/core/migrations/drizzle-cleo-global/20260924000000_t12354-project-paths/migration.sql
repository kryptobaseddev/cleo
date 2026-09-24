-- T12354 — the device-local project path map (`nexus_project_paths`) in the
-- consolidated GLOBAL cleo.db (drizzle-cleo-global scope ONLY — like the rest of
-- the nexus registry/identity tables it is cross-project and machine-wide, with
-- no project-tier analog, so it is NOT mirrored into drizzle-cleo-project).
--
-- `nexus_project_registry` holds ONE row per immutable project_id, so its
-- project_path can name only one checkout: two checkouts of the same project on
-- one device shared a row whose path followed whichever was touched last. This
-- table records every checkout, keyed by path (a path belongs to exactly one
-- project). Existing registry rows are backfilled as their first checkout.
--
-- ## Page-2 invariant
--
-- This migration runs AFTER the consolidation baseline (…_t11363-consolidation-
-- cleo-global) and many subsequent migrations, so `nexus_project_paths` is NEVER
-- the first CREATE on a fresh DB. No journal pre-create is required.
--
-- `IF NOT EXISTS` / `INSERT OR IGNORE` so a re-open over an already-migrated DB
-- is a no-op (idempotent). Each statement is separated by a drizzle breakpoint
-- marker line so node:sqlite prepare() does not silently truncate the
-- multi-statement file to statement one (the marker token is intentionally not
-- spelled out in this comment — drizzle's readMigrationFiles splits the file on
-- that literal substring).
--
-- @task T12354

CREATE TABLE IF NOT EXISTS `nexus_project_paths` (
  `project_path` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `project_hash` text NOT NULL,
  `first_seen` text NOT NULL DEFAULT (datetime('now')),
  `last_seen` text NOT NULL DEFAULT (datetime('now')),
  CHECK ("first_seen" IS NULL OR "first_seen" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
  CHECK ("last_seen" IS NULL OR "last_seen" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_nexus_project_paths_project_id` ON `nexus_project_paths` (`project_id`);
--> statement-breakpoint
INSERT OR IGNORE INTO `nexus_project_paths` (`project_path`, `project_id`, `project_hash`, `first_seen`, `last_seen`)
SELECT `project_path`, `project_id`, `project_hash`, `registered_at`, `last_seen` FROM `nexus_project_registry`;
