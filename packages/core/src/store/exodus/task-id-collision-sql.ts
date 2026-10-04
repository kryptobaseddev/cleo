/**
 * The one definition of a task-id collision between a legacy `tasks.db` and
 * the live `cleo.db` (T13172), shared by the reconcile (which renumbers them)
 * and the read-only `cleo doctor superseded-store` survey (which must never
 * call a file safe to archive while one of its tasks is only shadowed).
 *
 * Kept import-free so the survey can use it without loading the store stack.
 *
 * @module
 * @task T13172
 */

/**
 * Legacy tasks whose id a DIFFERENT live task holds: same id, different
 * creation instant (`julianday` compares ISO spellings of one instant as
 * equal). A different title alone is the same task edited since the cutover,
 * not a collision. Run on the live store with the legacy file attached as `legacy`.
 * Columns: `legacyId`, `legacyTitle`, `liveTitle`, and `recoveredAs`, the id of
 * a live task that already matches the legacy row (a previous reconcile
 * recovered it) or `NULL`.
 */
export const TASK_ID_COLLISIONS_SQL = `SELECT s.id AS legacyId, s.title AS legacyTitle, t.title AS liveTitle,
    (SELECT m.id FROM main.tasks_tasks m
      WHERE m.id <> s.id AND m.title IS s.title
        AND julianday(m.created_at) IS julianday(s.created_at)
      ORDER BY m.id LIMIT 1) AS recoveredAs
  FROM legacy.tasks s
  JOIN main.tasks_tasks t ON t.id = s.id
  WHERE julianday(t.created_at) IS NOT julianday(s.created_at)
  ORDER BY s.id`;
