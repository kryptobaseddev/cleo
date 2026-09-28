-- T12543: scope user-profile traits to the project they were derived in
-- (consolidated GLOBAL cleo.db, drizzle-cleo-global scope).
--
-- `nexus_user_profile` is a GLOBAL table, and the PSYCHE-MEMORY cold pass of
-- every spawn prompt read all of it, so traits derived while working in one
-- project were injected into agent prompts for every other project.
--
-- 1. `project_id` — the portable project id (`.cleo/project-id`, ADR-094) of
--    the project the trait was derived in. Nullable: every existing row gets
--    NULL = unknown origin. The reader excludes unknown-origin rows from spawn
--    prompts; they stay queryable (`cleo nexus profile view`) and the repair
--    path is `cleo memory prune-traits`.
-- 2. `scope` — 'project' | 'user'. Existing and new rows default to
--    'project'; only a trait EXPLICITLY marked 'user' is visible in every
--    project. The CHECK mirrors USER_PROFILE_SCOPES in @cleocode/contracts.
--
-- ADD COLUMN only (no table rebuild), so the migration journal probe
-- (reconcileJournal) detects it by column presence — see T12541.
ALTER TABLE `nexus_user_profile` ADD COLUMN `project_id` text;
--> statement-breakpoint
ALTER TABLE `nexus_user_profile` ADD COLUMN `scope` text DEFAULT 'project' NOT NULL CHECK ("scope" IN ('project', 'user'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_nexus_user_profile_project` ON `nexus_user_profile` (`project_id`, `scope`);
