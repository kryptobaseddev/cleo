-- T12819 (C2) — the trigger-suspension flag table, and the owned guard and
-- side-effect triggers rewritten with its WHEN clause. Journal spec
-- t12342-t12343-journal-design §3.5 Rule 4 and §2.3a rules 4, 9 and 10.
--
-- cleo_trigger_suspend(scope) is a flag table in MAIN. A frame that must run
-- with a class of triggers off inserts a scope row inside its own transaction
-- and deletes it before COMMIT. Under WAL no other connection sees the
-- uncommitted row, so everyone else keeps every trigger. A crash rolls the row
-- back, and the open pass asserts the table is empty.
--
-- The table is schema-owned and never dropped (not a _sync_ table): the
-- triggers below read it, so writes to tasks, sessions and acceptance
-- criteria, and any ALTER ... RENAME (which re-validates every trigger), need
-- it. The open pass also creates it, IF NOT EXISTS, before migrations.
--
-- Each owned trigger keeps its original text and gains
--   NOT EXISTS (SELECT 1 FROM cleo_trigger_suspend WHERE scope IN (<class>, all))
-- ANDed with its own WHEN. The table name is deliberately unqualified: a
-- persistent trigger resolves it in its own schema, so the trigger keeps
-- working when the store is ATTACHed under another name (exodus, backup).
-- A `main.` qualifier makes such a schema unreadable.
-- Released files that first created these triggers
-- (t11884, t12502, t12736) are never edited; this file replaces the triggers.
-- The T12341 AC graveyard trigger is owned too, but its DDL lives in code
-- (store/sync/trigger-classes.ts): a store whose t12341 migration was
-- probe-stamped has no graveyard TABLE, and creating the trigger here would
-- make every acceptance-criterion delete fail. The open pass installs it
-- only where its table exists.
-- The ownership map lives in packages/core/src/store/sync/trigger-classes.ts.
--
-- Idempotent (CREATE TABLE IF NOT EXISTS; DROP TRIGGER IF EXISTS before each
-- CREATE), and must always RUN: reconcileJournal never probe-stamps it.
-- cleo:probe-never-stamp
--
-- @task T12819
-- @epic T12323

CREATE TABLE IF NOT EXISTS `cleo_trigger_suspend` (
  `scope` TEXT PRIMARY KEY NOT NULL CHECK (`scope` IN ('capture', 'guard', 'side-effect', 'all'))
);
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tasks_tasks_parent_cycle_guard_insert`;
--> statement-breakpoint
CREATE TRIGGER `tasks_tasks_parent_cycle_guard_insert`
BEFORE INSERT ON `tasks_tasks`
WHEN (NEW.`parent_id` IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM cleo_trigger_suspend WHERE scope IN ('guard', 'all'))
BEGIN
  SELECT RAISE(ABORT, 'E_TASK_PARENT_CYCLE: tasks.parent_id cannot create a containment cycle')
  WHERE EXISTS (
    WITH RECURSIVE ancestors(`id`, `parent_id`) AS (
      SELECT parent.`id`, parent.`parent_id`
      FROM `tasks_tasks` parent
      WHERE parent.`id` = NEW.`parent_id`
      UNION ALL
      SELECT next_parent.`id`, next_parent.`parent_id`
      FROM `tasks_tasks` next_parent
      JOIN ancestors ON next_parent.`id` = ancestors.`parent_id`
      WHERE ancestors.`parent_id` IS NOT NULL
    )
    SELECT 1 FROM ancestors WHERE ancestors.`id` = NEW.`id`
  );
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tasks_tasks_parent_cycle_guard_update`;
--> statement-breakpoint
CREATE TRIGGER `tasks_tasks_parent_cycle_guard_update`
BEFORE UPDATE OF `parent_id` ON `tasks_tasks`
WHEN (NEW.`parent_id` IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM cleo_trigger_suspend WHERE scope IN ('guard', 'all'))
BEGIN
  SELECT RAISE(ABORT, 'E_TASK_PARENT_CYCLE: tasks.parent_id cannot create a containment cycle')
  WHERE EXISTS (
    WITH RECURSIVE ancestors(`id`, `parent_id`) AS (
      SELECT parent.`id`, parent.`parent_id`
      FROM `tasks_tasks` parent
      WHERE parent.`id` = NEW.`parent_id`
      UNION ALL
      SELECT next_parent.`id`, next_parent.`parent_id`
      FROM `tasks_tasks` next_parent
      JOIN ancestors ON next_parent.`id` = ancestors.`parent_id`
      WHERE ancestors.`parent_id` IS NOT NULL
    )
    SELECT 1 FROM ancestors WHERE ancestors.`id` = NEW.`id`
  );
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tasks_tasks_parent_type_matrix_insert`;
--> statement-breakpoint
CREATE TRIGGER `tasks_tasks_parent_type_matrix_insert`
BEFORE INSERT ON `tasks_tasks`
WHEN (NEW.`parent_id` IS NOT NULL
  AND NEW.`type` IS NOT NULL
  AND EXISTS (SELECT 1 FROM `tasks_tasks` parent WHERE parent.`id` = NEW.`parent_id` AND parent.`type` IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1
    FROM `tasks_tasks` parent
    WHERE parent.`id` = NEW.`parent_id`
      AND (
        (NEW.`type` = 'epic'  AND parent.`type` = 'saga')
        OR (NEW.`type` = 'task'   AND parent.`type` = 'epic')
        OR (NEW.`type` = 'subtask' AND parent.`type` IN ('epic', 'task'))
      )
  ))
  AND NOT EXISTS (SELECT 1 FROM cleo_trigger_suspend WHERE scope IN ('guard', 'all'))
BEGIN
  SELECT RAISE(ABORT, 'E_TASK_PARENT_TYPE_MATRIX: tasks.parent_id must follow saga->epic, epic->task|subtask, and task->subtask; sagas/tasks must be roots');
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tasks_tasks_parent_type_matrix_update`;
--> statement-breakpoint
CREATE TRIGGER `tasks_tasks_parent_type_matrix_update`
BEFORE UPDATE OF `parent_id`, `type` ON `tasks_tasks`
WHEN (NEW.`parent_id` IS NOT NULL
  AND NEW.`type` IS NOT NULL
  AND EXISTS (SELECT 1 FROM `tasks_tasks` parent WHERE parent.`id` = NEW.`parent_id` AND parent.`type` IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1
    FROM `tasks_tasks` parent
    WHERE parent.`id` = NEW.`parent_id`
      AND (
        (NEW.`type` = 'epic'  AND parent.`type` = 'saga')
        OR (NEW.`type` = 'task'   AND parent.`type` = 'epic')
        OR (NEW.`type` = 'subtask' AND parent.`type` IN ('epic', 'task'))
      )
  ))
  AND NOT EXISTS (SELECT 1 FROM cleo_trigger_suspend WHERE scope IN ('guard', 'all'))
BEGIN
  SELECT RAISE(ABORT, 'E_TASK_PARENT_TYPE_MATRIX: tasks.parent_id must follow saga->epic, epic->task|subtask, and task->subtask; sagas/tasks must be roots');
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_tasks_tasks_status_pipeline_insert`;
--> statement-breakpoint
CREATE TRIGGER `trg_tasks_tasks_status_pipeline_insert`
BEFORE INSERT ON `tasks_tasks`
FOR EACH ROW
WHEN ((NEW.`status` = 'done'      AND (NEW.`pipeline_stage` IS NULL OR NEW.`pipeline_stage` NOT IN ('contribution','cancelled')))
  OR (NEW.`status` = 'cancelled' AND (NEW.`pipeline_stage` IS NULL OR NEW.`pipeline_stage` != 'cancelled')))
  AND NOT EXISTS (SELECT 1 FROM cleo_trigger_suspend WHERE scope IN ('guard', 'all'))
BEGIN
  SELECT RAISE(ABORT, 'T877_INVARIANT_VIOLATION: status/pipeline_stage mismatch. status=done requires pipeline_stage IN (contribution,cancelled); status=cancelled requires pipeline_stage=cancelled.');
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_tasks_tasks_status_pipeline_update`;
--> statement-breakpoint
CREATE TRIGGER `trg_tasks_tasks_status_pipeline_update`
BEFORE UPDATE OF `status`, `pipeline_stage` ON `tasks_tasks`
FOR EACH ROW
WHEN ((NEW.`status` = 'done'      AND (NEW.`pipeline_stage` IS NULL OR NEW.`pipeline_stage` NOT IN ('contribution','cancelled')))
  OR (NEW.`status` = 'cancelled' AND (NEW.`pipeline_stage` IS NULL OR NEW.`pipeline_stage` != 'cancelled')))
  AND NOT EXISTS (SELECT 1 FROM cleo_trigger_suspend WHERE scope IN ('guard', 'all'))
BEGIN
  SELECT RAISE(ABORT, 'T877_INVARIANT_VIOLATION: status/pipeline_stage mismatch. status=done requires pipeline_stage IN (contribution,cancelled); status=cancelled requires pipeline_stage=cancelled.');
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tasks_task_relations_non_containment_insert`;
--> statement-breakpoint
CREATE TRIGGER `tasks_task_relations_non_containment_insert`
BEFORE INSERT ON `tasks_task_relations`
WHEN (EXISTS (
  SELECT 1
  FROM `tasks_tasks` child
  WHERE child.`id` = NEW.`task_id`
    AND child.`parent_id` = NEW.`related_to`
) OR EXISTS (
  SELECT 1
  FROM `tasks_tasks` child
  WHERE child.`id` = NEW.`related_to`
    AND child.`parent_id` = NEW.`task_id`
))
  AND NOT EXISTS (SELECT 1 FROM cleo_trigger_suspend WHERE scope IN ('guard', 'all'))
BEGIN
  SELECT RAISE(ABORT, 'E_TASK_RELATION_CONTAINMENT: task_relations is non-containment-only; use tasks.parent_id for parent/child edges');
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tasks_task_relations_non_containment_update`;
--> statement-breakpoint
CREATE TRIGGER `tasks_task_relations_non_containment_update`
BEFORE UPDATE OF `task_id`, `related_to` ON `tasks_task_relations`
WHEN (EXISTS (
  SELECT 1
  FROM `tasks_tasks` child
  WHERE child.`id` = NEW.`task_id`
    AND child.`parent_id` = NEW.`related_to`
) OR EXISTS (
  SELECT 1
  FROM `tasks_tasks` child
  WHERE child.`id` = NEW.`related_to`
    AND child.`parent_id` = NEW.`task_id`
))
  AND NOT EXISTS (SELECT 1 FROM cleo_trigger_suspend WHERE scope IN ('guard', 'all'))
BEGIN
  SELECT RAISE(ABORT, 'E_TASK_RELATION_CONTAINMENT: task_relations is non-containment-only; use tasks.parent_id for parent/child edges');
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tasks_task_acceptance_child_target_insert`;
--> statement-breakpoint
CREATE TRIGGER `tasks_task_acceptance_child_target_insert`
BEFORE INSERT ON `tasks_task_acceptance_criteria`
WHEN (NEW.`target_task_id` IS NOT NULL
  AND (
    NEW.`kind` <> 'child_task'
    OR NOT EXISTS (
      SELECT 1
      FROM `tasks_tasks` child
      WHERE child.`id` = NEW.`target_task_id`
        AND child.`parent_id` = NEW.`task_id`
    )
  ))
  AND NOT EXISTS (SELECT 1 FROM cleo_trigger_suspend WHERE scope IN ('guard', 'all'))
BEGIN
  SELECT RAISE(ABORT, 'E_CHILD_TASK_TARGET_CONTAINMENT: child_task acceptance target_task_id must be a direct child of task_id; non-child_task criteria must not set target_task_id');
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tasks_task_acceptance_child_target_update`;
--> statement-breakpoint
CREATE TRIGGER `tasks_task_acceptance_child_target_update`
BEFORE UPDATE OF `task_id`, `kind`, `target_task_id` ON `tasks_task_acceptance_criteria`
WHEN (NEW.`target_task_id` IS NOT NULL
  AND (
    NEW.`kind` <> 'child_task'
    OR NOT EXISTS (
      SELECT 1
      FROM `tasks_tasks` child
      WHERE child.`id` = NEW.`target_task_id`
        AND child.`parent_id` = NEW.`task_id`
    )
  ))
  AND NOT EXISTS (SELECT 1 FROM cleo_trigger_suspend WHERE scope IN ('guard', 'all'))
BEGIN
  SELECT RAISE(ABORT, 'E_CHILD_TASK_TARGET_CONTAINMENT: child_task acceptance target_task_id must be a direct child of task_id; non-child_task criteria must not set target_task_id');
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_tasks_session_handoff_no_update`;
--> statement-breakpoint
CREATE TRIGGER `trg_tasks_session_handoff_no_update`
BEFORE UPDATE ON `tasks_session_handoff_entries`
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM cleo_trigger_suspend WHERE scope IN ('guard', 'all'))
BEGIN
  SELECT RAISE(
    ABORT,
    'T1609_HANDOFF_IMMUTABLE: session_handoff_entries rows are write-once. Use persistHandoff() exactly once per session.'
  );
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tasks_tasks_lease_iso_insert`;
--> statement-breakpoint
CREATE TRIGGER `tasks_tasks_lease_iso_insert`
BEFORE INSERT ON `tasks_tasks`
WHEN ((NEW.`claimed_at` IS NOT NULL AND NEW.`claimed_at` NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
  OR (NEW.`lease_expires_at` IS NOT NULL AND NEW.`lease_expires_at` NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'))
  AND NOT EXISTS (SELECT 1 FROM cleo_trigger_suspend WHERE scope IN ('guard', 'all'))
BEGIN
  SELECT RAISE(ABORT, 'tasks_tasks.claimed_at and lease_expires_at must be ISO-8601 timestamps (T12736)');
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tasks_tasks_lease_iso_update`;
--> statement-breakpoint
CREATE TRIGGER `tasks_tasks_lease_iso_update`
BEFORE UPDATE OF `claimed_at`, `lease_expires_at` ON `tasks_tasks`
WHEN ((NEW.`claimed_at` IS NOT NULL AND NEW.`claimed_at` NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
  OR (NEW.`lease_expires_at` IS NOT NULL AND NEW.`lease_expires_at` NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'))
  AND NOT EXISTS (SELECT 1 FROM cleo_trigger_suspend WHERE scope IN ('guard', 'all'))
BEGIN
  SELECT RAISE(ABORT, 'tasks_tasks.claimed_at and lease_expires_at must be ISO-8601 timestamps (T12736)');
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_tasks_session_handoff_mirror`;
--> statement-breakpoint
CREATE TRIGGER `trg_tasks_session_handoff_mirror`
AFTER INSERT ON `tasks_session_handoff_entries`
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM cleo_trigger_suspend WHERE scope IN ('side-effect', 'all'))
BEGIN
  UPDATE `tasks_sessions`
     SET `handoff_json` = NEW.handoff_json
   WHERE `id` = NEW.session_id;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tasks_sessions_release_claims_on_end`;
--> statement-breakpoint
CREATE TRIGGER `tasks_sessions_release_claims_on_end`
AFTER UPDATE OF `status` ON `tasks_sessions`
WHEN (NEW.`status` IN ('ended', 'orphaned'))
  AND NOT EXISTS (SELECT 1 FROM cleo_trigger_suspend WHERE scope IN ('side-effect', 'all'))
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
WHEN NOT EXISTS (SELECT 1 FROM cleo_trigger_suspend WHERE scope IN ('side-effect', 'all'))
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
WHEN (NEW.`status` IN ('done', 'cancelled', 'archived') AND NEW.`claimed_by_session` IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM cleo_trigger_suspend WHERE scope IN ('side-effect', 'all'))
BEGIN
  UPDATE `tasks_tasks`
     SET `claimed_by_session` = NULL, `claimed_by_agent` = NULL,
         `claimed_at` = NULL, `lease_expires_at` = NULL
   WHERE `id` = NEW.`id`;
END;
