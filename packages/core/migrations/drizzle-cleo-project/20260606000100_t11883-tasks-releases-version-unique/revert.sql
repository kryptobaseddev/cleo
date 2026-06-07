-- Revert T11883 (E2) — drop the repaired UNIQUE index on tasks_releases.version.
-- @task T11883

DROP INDEX IF EXISTS `uq_tasks_releases_version`;
