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
 * Legacy tasks whose id a live task with a different creation instant holds.
 * Run on the live store with the legacy file attached as `legacy`.
 *
 * Columns:
 * - `legacyId`, `legacyTitle`, `legacyCreatedAt`, `liveTitle`;
 * - `decision`: `collision` when both creation times parse and differ (a
 *   different task), `undecided` when either does not parse (`julianday` is
 *   NULL) and the raw values differ: the rows cannot be told apart, so the
 *   reconcile reports them and never renumbers or duplicates;
 * - `recoveredAs`: for a `collision`, the live task an earlier run recovered
 *   it as, else `NULL`. A candidate has the same title and creation instant
 *   and an id that is NOT a legacy id (so it is not the legacy row's own copy
 *   or another legacy task). Twins (same title and instant, however the
 *   instant is spelled) are paired with candidates in id order, one to one,
 *   so no candidate is claimed twice.
 *
 * A recovery an earlier run recorded (its receipt's remap, loaded into
 * `temp.cleo_prior_recoveries` by `loadPriorRecoveries`, T13183) wins over the
 * title match when the recorded task still exists with the legacy creation
 * instant, so a recovered task retitled since is still recognised, and its id
 * leaves the candidate pool.
 *
 * A different title alone is the same task edited since the cutover.
 */
export const TASK_ID_COLLISIONS_SQL = `WITH
  collided AS (
    SELECT s.id AS legacyId, s.title AS legacyTitle, s.created_at AS legacyCreatedAt,
           t.title AS liveTitle,
           (SELECT m.id FROM temp.cleo_prior_recoveries p
              JOIN main.tasks_tasks m ON m.id = p.new_id
             WHERE p.legacy_id = s.id AND m.id <> s.id
               AND julianday(m.created_at) = julianday(s.created_at)
             ORDER BY p.seq DESC LIMIT 1) AS aliasId,
           CASE WHEN julianday(s.created_at) IS NULL OR julianday(t.created_at) IS NULL
                THEN 'undecided' ELSE 'collision' END AS decision
      FROM legacy.tasks s
      JOIN main.tasks_tasks t ON t.id = s.id
     WHERE CASE WHEN julianday(s.created_at) IS NULL OR julianday(t.created_at) IS NULL
                THEN t.created_at IS NOT s.created_at
                ELSE julianday(t.created_at) <> julianday(s.created_at) END
  ),
  numbered AS (
    SELECT legacyId, legacyTitle, julianday(legacyCreatedAt) AS instant,
           ROW_NUMBER() OVER (
             PARTITION BY legacyTitle, julianday(legacyCreatedAt) ORDER BY legacyId
           ) AS rn
      FROM collided WHERE decision = 'collision' AND aliasId IS NULL
  ),
  grp AS (SELECT DISTINCT legacyTitle, instant FROM numbered),
  candidates AS (
    SELECT g.legacyTitle, g.instant, m.id AS candidateId,
           ROW_NUMBER() OVER (PARTITION BY g.legacyTitle, g.instant ORDER BY m.id) AS rn
      FROM grp g
      JOIN main.tasks_tasks m
        ON m.title IS g.legacyTitle AND julianday(m.created_at) = g.instant
     WHERE m.id NOT IN (SELECT id FROM legacy.tasks)
       AND m.id NOT IN (SELECT aliasId FROM collided WHERE aliasId IS NOT NULL)
  )
SELECT c.legacyId, c.legacyTitle, c.legacyCreatedAt, c.liveTitle, c.decision,
       COALESCE(c.aliasId, k.candidateId) AS recoveredAs
  FROM collided c
  LEFT JOIN numbered n ON n.legacyId = c.legacyId
  LEFT JOIN candidates k
    ON k.legacyTitle IS n.legacyTitle AND k.instant = n.instant AND k.rn = n.rn
 ORDER BY c.legacyId`;

/**
 * The TEMP table {@link TASK_ID_COLLISIONS_SQL} reads earlier recoveries from.
 * Create it on the connection before running the query (empty is fine).
 */
export const PRIOR_RECOVERIES_TABLE_SQL = `CREATE TEMP TABLE IF NOT EXISTS cleo_prior_recoveries (
  seq INTEGER NOT NULL, legacy_id TEXT NOT NULL, new_id TEXT NOT NULL
)`;
