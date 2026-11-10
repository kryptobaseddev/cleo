-- T14311 (owner decision D11174) — the IVTR loop is retired and its
-- `ivtr_state` column goes with it.
--
-- Nothing has written `ivtr_state` since T11896 retired the phase walk, and
-- this build reads it nowhere: the `E_IVTR_INCOMPLETE` completion gate, the
-- release IVTR gate, `cleo show --ivtr-history` and `cleo orchestrate ivtr`
-- are deleted. Exit code 83 stays reserved.
--
-- One audit row per task that still carries IVTR state, written first, then
-- the column is dropped. The archive is deterministic, so every replica
-- writes the same rows: the audit id is `t14311-retire-ivtr-state-<task id>`
-- and its timestamp is the row's own `updated_at` (else `created_at`). The
-- raw JSON is kept as text in `before_json.ivtrState`, so nothing about the
-- old state is lost even when it does not parse.
-- `DROP COLUMN` is not a table rebuild: no FK parent is deleted from or
-- re-keyed. The migration runner drops and regenerates the capture triggers
-- around it, and a project store is snapshotted before data DML runs.
--
-- @task T14311

INSERT INTO `tasks_audit_log` (`id`, `timestamp`, `action`, `task_id`, `actor`, `details_json`, `before_json`, `after_json`, `domain`, `operation`, `source`)
SELECT
  't14311-retire-ivtr-state-' || `id`,
  COALESCE(`updated_at`, `created_at`),
  'task_ivtr_state_retired',
  `id`,
  'system',
  json_object('task', 'T14311', 'decision', 'D11174'),
  json_object('ivtrState', `ivtr_state`),
  json_object('ivtrState', NULL),
  'tasks',
  'migration',
  'migration'
FROM `tasks_tasks`
WHERE `ivtr_state` IS NOT NULL
ON CONFLICT (`id`) DO NOTHING;
--> statement-breakpoint
ALTER TABLE `tasks_tasks` DROP COLUMN `ivtr_state`;
