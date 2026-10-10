-- T12895 (epic T12323) — row uids for the brain natural-key tables (project store).
--
-- Adds a nullable `uid` column and a unique index on it to every brain table
-- keyed by a natural composite primary key. Natural tables carry no
-- `birth_fp`: the uid is a UUIDv8 over the key itself (references replaced by
-- the referenced row's uid where declared). Spec: `cleo docs fetch t12341-uid-scheme`.
--
-- The columns are filled by TypeScript at open (store/row-identity.ts, inside
-- the cold-open lease), and rows inserted by this build get theirs from the
-- per-connection TEMP trigger. Nothing here rebuilds a table or touches a row
-- (only ADD COLUMN and CREATE INDEX), so the T12541 rebuild probe and the
-- gate 36 DML rules do not apply; a probe-stamped store gets its columns and
-- indexes from the open's heal.
--
-- `brain_sticky_tags` gets the column too (the shared brain schema declares it
-- for both scopes), but in the project store its row identity waits on the
-- T12535 twin collapse: nothing fills it there until that change declares it.
--
-- @task T12895
-- @epic T12323

ALTER TABLE `brain_page_edges` ADD COLUMN `uid` text;
--> statement-breakpoint
ALTER TABLE `brain_memory_links` ADD COLUMN `uid` text;
--> statement-breakpoint
ALTER TABLE `brain_sticky_tags` ADD COLUMN `uid` text;
--> statement-breakpoint
ALTER TABLE `tasks_brain_release_links` ADD COLUMN `uid` text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_brain_page_edges_uid` ON `brain_page_edges` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_brain_memory_links_uid` ON `brain_memory_links` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_brain_sticky_tags_uid` ON `brain_sticky_tags` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_tasks_brain_release_links_uid` ON `tasks_brain_release_links` (`uid`);
