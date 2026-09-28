-- T12510 — `nexus_devices`: one row per machine that runs CLEO against this
-- global store, so `nexus_project_locations.device_id` (T12469) resolves to a
-- hostname / OS / architecture / CLEO version and a last-heartbeat instant.
--
-- `device_id` is the persisted `<cleoHome>/device-id` UUID (getStableDeviceId,
-- T9321) — the same id the location rows carry. The CLI upserts this device's
-- row at most once per minute (nexus/devices.ts `recordDeviceHeartbeat`).
--
-- ## Journal probe (T12541)
--
-- A pure CREATE TABLE + CREATE INDEX: the migration-manager DDL probe sees the
-- missing table on a store at main's state and lets drizzle run this file, and
-- sees the present table (and index) on a store that already has it and marks
-- the journal entry applied without re-running it. IF NOT EXISTS keeps a
-- re-run harmless either way. No data is touched.
--
-- Timestamp is after T12470's 20260928010000 so the two never collide.
--
-- @task T12510
-- @epic T12496

CREATE TABLE IF NOT EXISTS `nexus_devices` (
	`device_id` text PRIMARY KEY NOT NULL,
	`hostname` text NOT NULL,
	`os` text NOT NULL,
	`arch` text NOT NULL,
	`cleo_version` text NOT NULL,
	`first_seen` text NOT NULL DEFAULT (datetime('now')),
	`last_heartbeat_at` text NOT NULL DEFAULT (datetime('now')),
	CHECK ("first_seen" IS NULL OR "first_seen" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("last_heartbeat_at" IS NULL OR "last_heartbeat_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_nexus_devices_last_heartbeat` ON `nexus_devices` (`last_heartbeat_at`);
