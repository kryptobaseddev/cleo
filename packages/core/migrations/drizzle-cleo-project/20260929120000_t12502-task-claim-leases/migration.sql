-- T12502 (E-MULTI-SESSION · epic T12497) — leased agent claims on tasks.
--
-- Additive only. Four NULL-able columns on `tasks_tasks` hold the agent claim
-- lease, separate from the human `assignee` column:
--   claimed_by_session  session holding the lease
--   claimed_by_agent    agent identity of the holder
--   claimed_at          when the lease was taken
--   lease_expires_at    when it lapses unless renewed (ISO-8601 UTC TEXT)
-- `cleo start`, `cleo claim` and spawn take the lease with a compare-and-set
-- on these columns in the same write transaction (updateTaskFields). No
-- existing row changes: every column is NULL (unclaimed) after the migration.
-- Replication class: the columns are `local-only` (table-classification.ts).
--
-- Release triggers make the lease die with its holder on every write path:
--   * a session that ends or is orphaned releases all its leases;
--   * a deleted session releases all its leases (no FK: TEXT column);
--   * a task that reaches done / cancelled / archived releases its lease.
-- The triggers touch only the claim columns, so no other tasks_tasks trigger
-- (they are all UPDATE OF parent_id / status / pipeline_stage) fires.
--
-- @task T12502
-- @epic T12497

ALTER TABLE `tasks_tasks` ADD COLUMN `claimed_by_session` TEXT;
--> statement-breakpoint
ALTER TABLE `tasks_tasks` ADD COLUMN `claimed_by_agent` TEXT;
--> statement-breakpoint
ALTER TABLE `tasks_tasks` ADD COLUMN `claimed_at` TEXT;
--> statement-breakpoint
ALTER TABLE `tasks_tasks` ADD COLUMN `lease_expires_at` TEXT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tasks_tasks_claimed_by_session` ON `tasks_tasks` (`claimed_by_session`);
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tasks_sessions_release_claims_on_end`;
--> statement-breakpoint
CREATE TRIGGER `tasks_sessions_release_claims_on_end`
AFTER UPDATE OF `status` ON `tasks_sessions`
WHEN NEW.`status` IN ('ended', 'orphaned')
BEGIN
  UPDATE `tasks_tasks`
     SET `claimed_by_session` = NULL, `claimed_by_agent` = NULL,
         `claimed_at` = NULL, `lease_expires_at` = NULL
   WHERE `claimed_by_session` = NEW.`id`;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tasks_sessions_release_claims_on_delete`;
--> statement-breakpoint
CREATE TRIGGER `tasks_sessions_release_claims_on_delete`
AFTER DELETE ON `tasks_sessions`
BEGIN
  UPDATE `tasks_tasks`
     SET `claimed_by_session` = NULL, `claimed_by_agent` = NULL,
         `claimed_at` = NULL, `lease_expires_at` = NULL
   WHERE `claimed_by_session` = OLD.`id`;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tasks_tasks_release_claim_on_terminal`;
--> statement-breakpoint
CREATE TRIGGER `tasks_tasks_release_claim_on_terminal`
AFTER UPDATE OF `status` ON `tasks_tasks`
WHEN NEW.`status` IN ('done', 'cancelled', 'archived') AND NEW.`claimed_by_session` IS NOT NULL
BEGIN
  UPDATE `tasks_tasks`
     SET `claimed_by_session` = NULL, `claimed_by_agent` = NULL,
         `claimed_at` = NULL, `lease_expires_at` = NULL
   WHERE `id` = NEW.`id`;
END;
