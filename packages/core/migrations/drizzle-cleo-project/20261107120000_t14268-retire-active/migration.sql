-- T14268 (owner decision D11230) — stored `active` is retired.
--
-- A task reads `active` exactly while it holds a live claim lease
-- (`claimed_by_session` set and `lease_expires_at` in the future); the
-- status column stores `pending` for open work. This build already writes
-- `pending` for `active` and derives `active` at read, so this migration
-- only rewrites the rows older builds left behind.
--
-- One audit row per retired task, written first, then the status rewrite.
-- Both statements are deterministic, so every replica runs the same
-- backfill: the audit id is `t14268-retire-active-<task id>` and its
-- timestamp is the row's own `updated_at` (else `created_at`). The audit
-- keeps the lease the row held, so nothing about the old state is lost.
-- `updated_at` is left as it was.
-- A project store is snapshotted (`cleo.db.migration-<stamp>`) before
-- this migration runs; the runner refuses a pending set with data DML when
-- the snapshot cannot be written.
--
-- @task T14268

INSERT INTO `tasks_audit_log` (`id`, `timestamp`, `action`, `task_id`, `actor`, `details_json`, `before_json`, `after_json`, `domain`, `operation`, `source`)
SELECT
  't14268-retire-active-' || `id`,
  COALESCE(`updated_at`, `created_at`),
  'task_active_retired',
  `id`,
  'system',
  json_object('task', 'T14268', 'decision', 'D11230', 'claimedBySession', `claimed_by_session`, 'leaseExpiresAt', `lease_expires_at`),
  json_object('status', 'active'),
  json_object('status', 'pending'),
  'tasks',
  'migration',
  'migration'
FROM `tasks_tasks`
WHERE `status` = 'active'
ON CONFLICT (`id`) DO NOTHING;
--> statement-breakpoint
UPDATE `tasks_tasks` SET `status` = 'pending' WHERE `status` = 'active';
