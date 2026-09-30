-- T12886 — refuse a `tasks_task_dependencies` edge that closes a cycle.
--
-- `tasks_tasks_parent_cycle_guard_*` (T10572, restored by T11884) guards the
-- containment tree only. Nothing guarded the dependency graph: no trigger, and
-- no write path in TypeScript (`wouldCreateCycle` / `detectCircularDeps` are
-- read-only diagnostics). A cycle stalls every task on it forever: `cleo next`,
-- ready waves and orchestration all wait for a blocker that waits for them.
--
-- An edge (task_id → depends_on) means "task_id depends on depends_on". It
-- closes a cycle when task_id = depends_on (a self-dependency) or when
-- task_id is already reachable from depends_on through existing edges.
--
-- Bounded recursion: `reachable` has ONE column and uses UNION, so every task
-- id enters it at most once and the walk stops after at most one row per task.
-- No depth column exists to make a revisit distinct (the T12307 exit-143
-- failure mode), and no depth cap truncates a legitimately long chain. EXISTS
-- stops at the first match.
--
-- Re-inserting an edge that is already stored (INSERT … ON CONFLICT DO
-- NOTHING by the diff writers) is not checked, so a store that already holds a
-- legacy cycle stays writable; `cleo doctor dep-cycles` reports those cycles
-- with a repair plan. The UPDATE guard ignores the row's own OLD edge, which
-- is replaced by the update.
--
-- The RAISE message is a literal (an expression needs SQLite ≥ 3.47, and every
-- reader must be able to parse the schema). The TypeScript write chokepoint
-- (`batchUpdateDependencies`) translates it into an error that names the cycle.
--
-- @task T12886
-- @epic T12486

DROP TRIGGER IF EXISTS `tasks_task_dependencies_cycle_guard_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tasks_task_dependencies_cycle_guard_update`;
--> statement-breakpoint
CREATE TRIGGER `tasks_task_dependencies_cycle_guard_insert`
BEFORE INSERT ON `tasks_task_dependencies`
WHEN NOT EXISTS (
  SELECT 1
  FROM `tasks_task_dependencies` existing
  WHERE existing.`task_id` = NEW.`task_id`
    AND existing.`depends_on` = NEW.`depends_on`
)
BEGIN
  SELECT RAISE(ABORT, 'E_TASK_DEPENDENCY_CYCLE: tasks_task_dependencies edge would close a dependency cycle (a task cannot depend on itself or on a task that already depends on it)')
  WHERE NEW.`task_id` = NEW.`depends_on`
    OR EXISTS (
      WITH RECURSIVE reachable(`id`) AS (
        SELECT NEW.`depends_on`
        UNION
        SELECT dep.`depends_on`
        FROM `tasks_task_dependencies` dep
        JOIN reachable ON dep.`task_id` = reachable.`id`
      )
      SELECT 1 FROM reachable WHERE reachable.`id` = NEW.`task_id`
    );
END;
--> statement-breakpoint
CREATE TRIGGER `tasks_task_dependencies_cycle_guard_update`
BEFORE UPDATE OF `task_id`, `depends_on` ON `tasks_task_dependencies`
WHEN NEW.`task_id` IS NOT OLD.`task_id` OR NEW.`depends_on` IS NOT OLD.`depends_on`
BEGIN
  SELECT RAISE(ABORT, 'E_TASK_DEPENDENCY_CYCLE: tasks_task_dependencies edge would close a dependency cycle (a task cannot depend on itself or on a task that already depends on it)')
  WHERE NEW.`task_id` = NEW.`depends_on`
    OR EXISTS (
      WITH RECURSIVE reachable(`id`) AS (
        SELECT NEW.`depends_on`
        UNION
        SELECT dep.`depends_on`
        FROM `tasks_task_dependencies` dep
        JOIN reachable ON dep.`task_id` = reachable.`id`
        WHERE NOT (dep.`task_id` = OLD.`task_id` AND dep.`depends_on` = OLD.`depends_on`)
      )
      SELECT 1 FROM reachable WHERE reachable.`id` = NEW.`task_id`
    );
END;
