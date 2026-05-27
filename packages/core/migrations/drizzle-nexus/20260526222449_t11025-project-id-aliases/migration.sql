-- T11025: Create project_id_aliases table for identity alias resolution.
-- Maps legacy base64url(path) project IDs to their canonical 12-hex-char IDs.
-- Used by nexusRenameProject (self-alias registration) and resolveProjectById
-- in paths.ts (legacy → canonical ID lookup).
--
-- Populated during rename (identity self-aliases) and project ID migration
-- (legacy→canonical mappings). The table was defined in the Drizzle schema
-- since T9149 W5 but no migration file existed — fresh nexes.db init would
-- create it via drizzle push but not via the migration chain.
CREATE TABLE IF NOT EXISTS `project_id_aliases` (
  `legacy_id` text PRIMARY KEY,
  `canonical_id` text NOT NULL,
  `created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_project_id_aliases_canonical` ON `project_id_aliases` (`canonical_id`);
