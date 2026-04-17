-- T877: Pipeline stage invariants — structural fix replacing the two TS
--       backfills (T869 pipeline-stage-from-lifecycle, T871 terminal-stage).
--
-- ==========================================================================
-- Problem
-- ==========================================================================
-- Two one-shot TS backfills were living in packages/core/src/lifecycle/:
--   * backfill-pipeline-stage.ts — syncs `tasks.pipeline_stage` with the
--     highest `lifecycle_stages.stage_name` for each task (pre-T832 drift).
--   * backfill-terminal-pipeline-stage.ts — sets `pipeline_stage` to
--     'contribution' or 'cancelled' for terminal status rows (pre-T871).
--
-- Both are band-aids for real structural invariants the database itself was
-- not enforcing. This migration moves them into the migration stream AND
-- adds triggers so the invariants hold going forward.
--
-- ==========================================================================
-- Solution
-- ==========================================================================
-- 1. SQL-native one-shot data fix: run the same logic the TS backfills did,
--    but as UPDATEs inside this migration so drizzle's journal marks it
--    done atomically. No more "did the backfill run?" question — if this
--    migration is in __drizzle_migrations, the data is consistent.
--
-- 2. SQLite triggers enforce the invariants on every INSERT/UPDATE to
--    `tasks`. These are the structural equivalent of CHECK constraints but
--    without requiring a table rebuild (SQLite cannot add CHECK to an
--    existing table non-destructively). Triggers RAISE ABORT on violation.
--
--    Invariants enforced:
--      A. status='done'       -> pipeline_stage IN ('contribution','cancelled')
--      B. status='cancelled'  -> pipeline_stage='cancelled'
--
--    These match the runtime behaviour in packages/core/src/tasks/{complete,cancel-ops}.ts
--    (T871) so legitimate writes are never blocked.
--
-- @task T877
-- @epic T876 (owner-labelled T900)

-- --------------------------------------------------------------------------
-- Part 1: Data fix — terminal-stage alignment (replaces T871 backfill)
-- --------------------------------------------------------------------------
-- For every status='done' row whose pipeline_stage is NULL or a non-terminal
-- intermediate stage, set pipeline_stage='contribution'.
UPDATE `tasks`
   SET `pipeline_stage` = 'contribution',
       `updated_at`     = datetime('now')
 WHERE `status` = 'done'
   AND (
         `pipeline_stage` IS NULL
      OR `pipeline_stage` IN (
           'research','consensus','architecture_decision','specification',
           'decomposition','implementation','validation','testing','release'
         )
       );
--> statement-breakpoint

-- For every status='cancelled' row whose pipeline_stage is NULL or a non-terminal
-- intermediate stage, set pipeline_stage='cancelled'.
UPDATE `tasks`
   SET `pipeline_stage` = 'cancelled',
       `updated_at`     = datetime('now')
 WHERE `status` = 'cancelled'
   AND (
         `pipeline_stage` IS NULL
      OR `pipeline_stage` IN (
           'research','consensus','architecture_decision','specification',
           'decomposition','implementation','validation','testing','release',
           'contribution'
         )
       );
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Part 2: Data fix — lifecycle → pipeline_stage sync (replaces T869 backfill)
-- --------------------------------------------------------------------------
-- For every task whose highest completed/in_progress/skipped lifecycle_stages
-- row sits AHEAD of its current pipeline_stage, advance pipeline_stage to
-- that stage. Matches `backfillPipelineStageFromLifecycle` exactly.
--
-- Stage order (1-based) is expressed via CASE so we do not need a helper
-- table. Only tasks still in intermediate stages are touched — terminal
-- rows handled above.
UPDATE `tasks`
   SET `pipeline_stage` = (
         SELECT highest.stage_name
           FROM (
             SELECT
               lp.task_id    AS task_id,
               ls.stage_name AS stage_name,
               ls.sequence   AS sequence
             FROM `lifecycle_pipelines` lp
             JOIN `lifecycle_stages`    ls ON ls.pipeline_id = lp.id
             WHERE ls.status IN ('completed','in_progress','skipped')
           ) highest
          WHERE highest.task_id = tasks.id
          ORDER BY highest.sequence DESC
          LIMIT 1
       ),
       `updated_at` = datetime('now')
 WHERE `tasks`.`id` IN (
         SELECT lp.task_id
           FROM `lifecycle_pipelines` lp
           JOIN `lifecycle_stages`    ls ON ls.pipeline_id = lp.id
          WHERE ls.status IN ('completed','in_progress','skipped')
          GROUP BY lp.task_id
       )
   AND (
         `tasks`.`pipeline_stage` IS NULL
      OR (
           -- only advance when the lifecycle stage is strictly ahead
           (SELECT MAX(ls.sequence)
              FROM `lifecycle_pipelines` lp
              JOIN `lifecycle_stages`    ls ON ls.pipeline_id = lp.id
             WHERE lp.task_id = tasks.id
               AND ls.status IN ('completed','in_progress','skipped'))
           >
           (CASE `tasks`.`pipeline_stage`
              WHEN 'research'              THEN 1
              WHEN 'consensus'             THEN 2
              WHEN 'architecture_decision' THEN 3
              WHEN 'specification'         THEN 4
              WHEN 'decomposition'         THEN 5
              WHEN 'implementation'        THEN 6
              WHEN 'validation'            THEN 7
              WHEN 'testing'               THEN 8
              WHEN 'release'               THEN 9
              WHEN 'contribution'          THEN 10
              WHEN 'cancelled'             THEN 11
              ELSE 0
            END)
         )
       )
   -- Never overwrite a terminal stage with an intermediate one.
   AND (`tasks`.`pipeline_stage` IS NULL
        OR `tasks`.`pipeline_stage` NOT IN ('contribution','cancelled'));
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Part 3: Triggers — enforce invariants on every INSERT/UPDATE
-- --------------------------------------------------------------------------
-- Invariant A: status='done' requires pipeline_stage IN ('contribution','cancelled').
-- Invariant B: status='cancelled' requires pipeline_stage='cancelled'.
--
-- We use triggers (not CHECK) because SQLite cannot add a CHECK constraint
-- to an existing column without a full table rebuild. Triggers are cheaper
-- to add and let us produce a clear error message on violation.
--
-- Drop-then-create makes the migration idempotent if replayed.
DROP TRIGGER IF EXISTS `trg_tasks_status_pipeline_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_tasks_status_pipeline_update`;
--> statement-breakpoint

CREATE TRIGGER `trg_tasks_status_pipeline_insert`
BEFORE INSERT ON `tasks`
FOR EACH ROW
WHEN (NEW.`status` = 'done'      AND (NEW.`pipeline_stage` IS NULL OR NEW.`pipeline_stage` NOT IN ('contribution','cancelled')))
  OR (NEW.`status` = 'cancelled' AND (NEW.`pipeline_stage` IS NULL OR NEW.`pipeline_stage` != 'cancelled'))
BEGIN
  SELECT RAISE(ABORT, 'T877_INVARIANT_VIOLATION: status/pipeline_stage mismatch. status=done requires pipeline_stage IN (contribution,cancelled); status=cancelled requires pipeline_stage=cancelled.');
END;
--> statement-breakpoint

CREATE TRIGGER `trg_tasks_status_pipeline_update`
BEFORE UPDATE OF `status`, `pipeline_stage` ON `tasks`
FOR EACH ROW
WHEN (NEW.`status` = 'done'      AND (NEW.`pipeline_stage` IS NULL OR NEW.`pipeline_stage` NOT IN ('contribution','cancelled')))
  OR (NEW.`status` = 'cancelled' AND (NEW.`pipeline_stage` IS NULL OR NEW.`pipeline_stage` != 'cancelled'))
BEGIN
  SELECT RAISE(ABORT, 'T877_INVARIANT_VIOLATION: status/pipeline_stage mismatch. status=done requires pipeline_stage IN (contribution,cancelled); status=cancelled requires pipeline_stage=cancelled.');
END;
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Part 4: Record migration in schema_meta for historical audit (optional)
-- --------------------------------------------------------------------------
-- Keep schema_meta keys from the old TS backfills populated so any code that
-- still checks `isTerminalPipelineStageBackfillDone()` / `isPipelineStageBackfillDone()`
-- continues to return true. This makes removal of the TS files safe in any
-- order and lets us retire them without breaking in-flight callers.
INSERT INTO `schema_meta` (`key`, `value`) VALUES
  ('backfill:pipeline-stage-from-lifecycle', '{"ranAt":"migration:T877","task":"T877","replacedBy":"T877_migration"}'),
  ('backfill:terminal-pipeline-stage',       '{"ranAt":"migration:T877","task":"T877","replacedBy":"T877_migration"}')
ON CONFLICT(`key`) DO UPDATE SET `value` = excluded.`value`;
