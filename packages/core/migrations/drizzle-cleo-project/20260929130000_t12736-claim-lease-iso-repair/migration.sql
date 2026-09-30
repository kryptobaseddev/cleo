-- T12736 — repair stores where t12502 (task claim leases) was only half applied.
--
-- Pre-release builds of t12502 each shipped a different migration.sql. A store
-- migrated by one of them, then reconciled by another, ended with the t12502
-- journal row stamped although two parts of the migration never ran:
--   * the ISO-8601 CHECKs on tasks_tasks.claimed_at / lease_expires_at
--     (SQLite cannot add a CHECK to an existing column), and
--   * the index idx_tasks_sessions_spawned_by.
-- The t12502 hash is journaled on those stores, so t12502 never runs again.
--
-- This migration restores both without a table rebuild, and is idempotent:
--   * the index is created IF NOT EXISTS;
--   * two BEFORE triggers enforce the same GLOB the CHECKs use, on INSERT and
--     on UPDATE OF either column, and abort a non-ISO value.
-- On a store where t12502 applied fully the CHECKs are already there; the
-- triggers then only repeat them, so behaviour does not change. The names
-- avoid the word "claim" so they stay apart from t12502's release triggers.
--
-- @task T12736

CREATE INDEX IF NOT EXISTS `idx_tasks_sessions_spawned_by` ON `tasks_sessions` (`spawned_by_session_id`);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `tasks_tasks_lease_iso_insert`
BEFORE INSERT ON `tasks_tasks`
WHEN (NEW.`claimed_at` IS NOT NULL AND NEW.`claimed_at` NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
  OR (NEW.`lease_expires_at` IS NOT NULL AND NEW.`lease_expires_at` NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
BEGIN
  SELECT RAISE(ABORT, 'tasks_tasks.claimed_at and lease_expires_at must be ISO-8601 timestamps (T12736)');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `tasks_tasks_lease_iso_update`
BEFORE UPDATE OF `claimed_at`, `lease_expires_at` ON `tasks_tasks`
WHEN (NEW.`claimed_at` IS NOT NULL AND NEW.`claimed_at` NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
  OR (NEW.`lease_expires_at` IS NOT NULL AND NEW.`lease_expires_at` NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
BEGIN
  SELECT RAISE(ABORT, 'tasks_tasks.claimed_at and lease_expires_at must be ISO-8601 timestamps (T12736)');
END;
