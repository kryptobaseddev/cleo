-- T9163: Add is_external column to nexus_nodes via explicit forward migration.
-- Prior to this migration the column was only created by the ensureColumns()
-- safety net in nexus-sqlite.ts (T1062). Fresh installs that run the full
-- migration chain will now get the column from Drizzle instead of from the
-- safety net, eliminating the "Adding missing column nexus_nodes.is_external"
-- warning on cleo init.
--
-- NOT NULL DEFAULT false (= 0): matches the Drizzle schema definition
-- `integer('is_external', { mode: 'boolean' }).notNull().default(false)`.
--
-- Legacy DBs where ensureColumns already ran the ALTER TABLE will hit a
-- duplicate-column error. migration-manager.isDuplicateColumnError +
-- reconcileJournal Scenario 3 already handles this path (Case A: all ALTER
-- targets already exist → mark journal entry applied and skip re-run).
--
-- The ensureColumns() call in nexus-sqlite.ts is intentionally RETAINED as a
-- repair net for legacy DBs that were upgraded out-of-band.
ALTER TABLE `nexus_nodes` ADD COLUMN `is_external` integer NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE INDEX `idx_nexus_nodes_is_external` ON `nexus_nodes` (`is_external`);
