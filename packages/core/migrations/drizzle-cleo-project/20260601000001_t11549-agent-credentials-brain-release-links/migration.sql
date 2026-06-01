-- T11549: Add agent_credentials and brain_release_links to consolidated cleo-project schema.
--
-- These tables exist in the legacy brain.db (3 rows agent_credentials, 8 rows
-- brain_release_links) and need consolidated targets so the exodus migration can
-- copy all 11 rows to the project-scope cleo.db instead of silently skipping them.
--
-- agent_credentials mirrors the legacy `agent_credentials` table from
-- packages/core/migrations/drizzle-tasks/20260327000000_agent-credentials/migration.sql.
-- It is prefixed `tasks_agent_credentials` (tasks domain — agent runtime data).
--
-- brain_release_links mirrors the legacy `brain_release_links` table from
-- packages/core/src/store/schema/provenance/releases.ts (brainReleaseLinks).
-- It is prefixed `tasks_brain_release_links` (tasks provenance domain) to match
-- the existing tasks_releases parent table.

CREATE TABLE IF NOT EXISTS `tasks_agent_credentials` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`api_key_encrypted` text NOT NULL,
	`api_base_url` text NOT NULL DEFAULT 'https://api.signaldock.io',
	`classification` text,
	`privacy_tier` text NOT NULL DEFAULT 'public',
	`capabilities` text NOT NULL DEFAULT '[]',
	`skills` text NOT NULL DEFAULT '[]',
	`transport_config` text NOT NULL DEFAULT '{}',
	`is_active` integer NOT NULL DEFAULT 1,
	`last_used_at` integer,
	`created_at` integer NOT NULL DEFAULT (unixepoch()),
	`updated_at` integer NOT NULL DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tasks_agent_cred_active` ON `tasks_agent_credentials` (`is_active`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tasks_agent_cred_last_used` ON `tasks_agent_credentials` (`last_used_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `tasks_brain_release_links` (
	`brain_entry_id` text,
	`release_id` text NOT NULL,
	`link_type` text NOT NULL CHECK ("link_type" IN ('approved-by', 'documented-in', 'derived-from', 'observed-in')),
	`created_at` text NOT NULL DEFAULT (datetime('now')),
	`created_by` text,
	PRIMARY KEY(`brain_entry_id`, `release_id`, `link_type`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tasks_brain_rel_links_brain_entry_id` ON `tasks_brain_release_links` (`brain_entry_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tasks_brain_rel_links_release_id` ON `tasks_brain_release_links` (`release_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tasks_brain_rel_links_link_type` ON `tasks_brain_release_links` (`link_type`);
