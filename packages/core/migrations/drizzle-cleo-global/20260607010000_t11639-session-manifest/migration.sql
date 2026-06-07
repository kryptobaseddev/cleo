-- T11639 (EP-SESSION-MANIFEST · epic T11638) — cross-project `session_manifest`
-- MIRROR table in the consolidated GLOBAL cleo.db (drizzle-cleo-global scope).
--
-- The authoritative session row lives per-project in `tasks_sessions` (PROJECT
-- scope). A best-effort writer mirrors a compact projection into this GLOBAL row so
-- the fleet has one machine-wide view of every session across every project without
-- ATTACHing N per-project DBs. NOT authoritative (deliberately NOT named `sessions`):
-- reconcile-on-start re-reads the project row and overwrites this row so it can never
-- drift into authority.
--
-- `project_id` is a soft FK → `nexus_project_registry.project_id` (same cleo.db),
-- nullable for sessions started outside any registered project. `parent_session_id`
-- is a soft self-reference (fork tree, sourced from CLEO_PARENT_SESSION_ID / T11629),
-- nullable for root sessions. No native FKs: the mirror must tolerate a project row
-- that lands before/without its registry/parent peer.
--
-- `IF NOT EXISTS` so a re-open over an already-migrated DB is a no-op. Each statement
-- is separated by a drizzle breakpoint marker so node:sqlite prepare() does not
-- truncate the multi-statement file to statement one.
--
-- @task T11639
-- @epic T11638

CREATE TABLE IF NOT EXISTS `session_manifest` (
  `session_id` text PRIMARY KEY NOT NULL,
  `project_id` text,
  `parent_session_id` text,
  `name` text,
  `status` text,
  `project_path` text,
  `started_at` text,
  `ended_at` text,
  `mirrored_at` text NOT NULL DEFAULT (datetime('now')),
  CHECK ("started_at" IS NULL OR "started_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
  CHECK ("ended_at" IS NULL OR "ended_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
  CHECK ("mirrored_at" IS NULL OR "mirrored_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_session_manifest_project_id` ON `session_manifest` (`project_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_session_manifest_parent` ON `session_manifest` (`parent_session_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_session_manifest_status` ON `session_manifest` (`status`);
