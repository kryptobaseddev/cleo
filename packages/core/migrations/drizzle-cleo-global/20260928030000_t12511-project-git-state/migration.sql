-- T12511 — `nexus_project_git_state`: the last git state probe of each project
-- location, keyed exactly like `nexus_project_locations` (T12469) —
-- (project_id, device_id, path) — so every device sharing this store can see
-- where a project lives, on which machine, and its local and remote git state.
--
-- Written by `cleo nexus projects status` (nexus/git-state.ts). A failed probe
-- still writes its row with `probe_error_code` set. Remote columns describe the
-- remote as of `remote_fetched_at` (FETCH_HEAD's mtime), never "now": the probe
-- runs no `git fetch` unless `--fetch` is passed.
--
-- A separate table rather than columns on `nexus_project_locations`: location
-- rows are identity/liveness facts written on every encounter, while probe rows
-- are volatile observations rewritten wholesale by one command. Keeping them
-- apart means a probe never races an encounter write on the same row.
--
-- ## Journal probe (T12541)
--
-- A pure CREATE TABLE + CREATE INDEX: on a store at main's state the DDL probe
-- sees the missing table and lets drizzle run this file; on a store that has it
-- the entry is marked applied. IF NOT EXISTS keeps a re-run harmless. No data
-- is touched.
--
-- CHECK constraints are written exactly as the schema derives them (T11364
-- parity). A NULL `probe_error_code` passes the IN check, because a CHECK
-- rejects only FALSE.
--
-- Timestamp is after T12510's 20260928020000 so the two never collide.
--
-- @task T12511
-- @epic T12496

CREATE TABLE IF NOT EXISTS `nexus_project_git_state` (
	`project_id` text NOT NULL,
	`device_id` text NOT NULL,
	`path` text NOT NULL,
	`git_root` text,
	`branch` text,
	`head_sha` text,
	`detached` integer DEFAULT false NOT NULL,
	`shallow` integer DEFAULT false NOT NULL,
	`dirty_count` integer,
	`untracked_count` integer,
	`upstream` text,
	`ahead` integer,
	`behind` integer,
	`remote_name` text,
	`remote_url` text,
	`remote_head_sha` text,
	`remote_fetched_at` text,
	`probed_at` text NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`probe_error_code` text,
	`probe_error` text,
	PRIMARY KEY (`project_id`, `device_id`, `path`),
	CHECK ("detached" IN (0, 1)),
	CHECK ("shallow" IN (0, 1)),
	CHECK ("probe_error_code" IN ('E_PATH_MISSING', 'E_PATH_ACCESS', 'E_NOT_GIT_REPO', 'E_GIT_TIMEOUT', 'E_GIT_FAILED', 'E_FETCH_FAILED')),
	CHECK ("remote_fetched_at" IS NULL OR "remote_fetched_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("probed_at" IS NULL OR "probed_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_nexus_project_git_state_device` ON `nexus_project_git_state` (`device_id`);
