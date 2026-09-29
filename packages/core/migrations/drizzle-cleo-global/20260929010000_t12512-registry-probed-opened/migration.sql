-- T12512 — separate "last probed" from "last opened" on the project registry
-- (drizzle-cleo-global scope ONLY).
--
-- `last_seen` was bumped by health checks and `nexus sync`, so it meant "last
-- probed", never "last used": a project nobody had opened for a year looked
-- fresh after one `cleo doctor`. Two nullable columns split the meanings:
--
--   `last_probed_at` — written by health checks, `nexus sync` and the git state
--                      probe (`cleo nexus projects status --refresh`). Never
--                      evidence of use.
--   `last_opened_at` — written only by real CLI use inside the project (the
--                      CLI's per-command project encounter), at most once a
--                      minute per project.
--
-- `last_opened_at` is indexed so the fleet view (T12513) can order or filter by
-- activity without a scan.
--
-- ## Journal probe (T12541)
--
-- The two `ADD COLUMN` statements are the probe targets: on a store at main's
-- state they are missing, so this migration runs; on a store that has them the
-- entry is marked applied. The index uses IF NOT EXISTS so a re-run is
-- harmless. No row is touched: both columns start NULL ("never"), the honest
-- value — past `last_seen` bumps cannot be attributed to either meaning.
--
-- Timestamp is after T12511's 20260928030000 so the two never collide.
--
-- @task T12512
-- @epic T12496

ALTER TABLE `nexus_project_registry` ADD COLUMN `last_probed_at` text CHECK ("last_probed_at" IS NULL OR "last_probed_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*');
--> statement-breakpoint
ALTER TABLE `nexus_project_registry` ADD COLUMN `last_opened_at` text CHECK ("last_opened_at" IS NULL OR "last_opened_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_nexus_project_registry_last_opened` ON `nexus_project_registry` (`last_opened_at`);
