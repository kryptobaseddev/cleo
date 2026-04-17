/**
 * One-shot data migration: align `tasks.pipeline_stage` with `tasks.status`
 * for rows in terminal task states (status = 'done' | 'cancelled').
 *
 * Problem (T871):
 *   Prior to T871 `cleo complete` and `cleo cancel` did not auto-advance
 *   `tasks.pipeline_stage`. As a result tasks could reach `status='done'`
 *   while `pipeline_stage` stayed at an intermediate IVTR value such as
 *   `research`, `implementation`, or `release`. Studio's Pipeline view
 *   groups tasks by `pipeline_stage`, so its DONE column renders empty
 *   even when the underlying data shows 28+ completed tasks.
 *
 * Solution:
 *   For every task where:
 *     (a) `status = 'done'` AND `pipeline_stage` is not already a terminal
 *         marker, set `pipeline_stage = 'contribution'` (the natural
 *         terminal stage per the RCASD-IVTR+C chain).
 *     (b) `status = 'cancelled'` AND `pipeline_stage` is not already a
 *         terminal marker, set `pipeline_stage = 'cancelled'`.
 *
 * Idempotency:
 *   Guarded by a `schema_meta` row with key
 *   `'backfill:terminal-pipeline-stage'`. Running twice is a no-op.
 *
 * @task T871
 * @epic T870
 */

import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { getDb } from '../store/sqlite.js';
import * as schema from '../store/tasks-schema.js';
import { TERMINAL_PIPELINE_STAGES } from '../tasks/pipeline-stage.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** schema_meta key that records the terminal-stage backfill as run. */
export const TERMINAL_BACKFILL_KEY = 'backfill:terminal-pipeline-stage';

/** Terminal pipeline stage names (string form for SQL `IN (...)` matching). */
const TERMINAL_STAGES: readonly string[] = Array.from(TERMINAL_PIPELINE_STAGES);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-task change record returned in the result summary. */
export interface TerminalPipelineStageBackfillChange {
  /** Task ID that was updated. */
  taskId: string;
  /** Task status driving the backfill ('done' | 'cancelled'). */
  status: 'done' | 'cancelled';
  /** Stage that was previously stored in task.pipeline_stage (null = never set). */
  previousStage: string | null;
  /** Stage applied by the backfill. */
  newStage: 'contribution' | 'cancelled';
}

/** Overall result returned by {@link backfillTerminalPipelineStage}. */
export interface TerminalPipelineStageBackfillResult {
  /** If true, the backfill had already run in a previous call — no work done. */
  alreadyRun: boolean;
  /** If true, no changes were written (preview mode). */
  dryRun: boolean;
  /** Number of tasks inspected. */
  tasksScanned: number;
  /** Number of tasks whose pipeline_stage was (or would be) updated. */
  tasksUpdated: number;
  /** Per-task detail of what changed. */
  changes: TerminalPipelineStageBackfillChange[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Backfill `tasks.pipeline_stage` to match terminal `status` values.
 *
 * @remarks
 * The migration is idempotent: a `schema_meta` row with key
 * {@link TERMINAL_BACKFILL_KEY} is written on first success and checked on
 * every subsequent call.
 *
 * @param options - Optional overrides
 * @param options.dryRun - When true, compute changes but do not write to DB.
 * @param options.force  - When true, ignore the idempotency guard and re-run.
 * @param cwd - Project working directory (passed through to getDb).
 * @returns Summary of what was (or would be) changed.
 *
 * @example
 * ```ts
 * const result = await backfillTerminalPipelineStage({ dryRun: true });
 * console.log(result.tasksUpdated); // number of drifted done/cancelled rows
 * ```
 *
 * @task T871
 */
export async function backfillTerminalPipelineStage(
  options: { dryRun?: boolean; force?: boolean } = {},
  cwd?: string,
): Promise<TerminalPipelineStageBackfillResult> {
  const { dryRun = false, force = false } = options;
  const db = await getDb(cwd);

  // ------------------------------------------------------------------
  // 1. Idempotency check
  // ------------------------------------------------------------------
  if (!force) {
    const guard = await db
      .select()
      .from(schema.schemaMeta)
      .where(eq(schema.schemaMeta.key, TERMINAL_BACKFILL_KEY))
      .limit(1)
      .all();

    if (guard.length > 0) {
      return {
        alreadyRun: true,
        dryRun,
        tasksScanned: 0,
        tasksUpdated: 0,
        changes: [],
      };
    }
  }

  // ------------------------------------------------------------------
  // 2. Select every task with status in ('done', 'cancelled') whose
  //    pipeline_stage is NOT already a terminal marker (NULL counts as
  //    not-terminal since we want to fix un-set rows too).
  // ------------------------------------------------------------------

  const rows = await db
    .select({
      id: schema.tasks.id,
      status: schema.tasks.status,
      pipelineStage: schema.tasks.pipelineStage,
    })
    .from(schema.tasks)
    .where(inArray(schema.tasks.status, ['done', 'cancelled']))
    .all();

  const tasksScanned = rows.length;

  // ------------------------------------------------------------------
  // 3. Compute per-row target stage
  // ------------------------------------------------------------------

  const changes: TerminalPipelineStageBackfillChange[] = [];

  for (const row of rows) {
    // Skip rows that already sit on a terminal marker.
    if (row.pipelineStage && TERMINAL_STAGES.includes(row.pipelineStage)) {
      continue;
    }

    const status = row.status as 'done' | 'cancelled';
    const newStage: 'contribution' | 'cancelled' = status === 'done' ? 'contribution' : 'cancelled';

    changes.push({
      taskId: row.id,
      status,
      previousStage: row.pipelineStage ?? null,
      newStage,
    });
  }

  // ------------------------------------------------------------------
  // 4. Apply updates (unless dryRun)
  // ------------------------------------------------------------------

  if (!dryRun && changes.length > 0) {
    const now = new Date().toISOString();

    // Two bulk UPDATEs (one per terminal status) are cheaper than a row-
    // by-row update, but we also need per-row `updated_at` stamping so we
    // apply rows individually. Volume is small (dozens, not thousands).
    for (const change of changes) {
      await db
        .update(schema.tasks)
        .set({
          pipelineStage: change.newStage,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.tasks.id, change.taskId),
            or(
              isNull(schema.tasks.pipelineStage),
              inArray(schema.tasks.pipelineStage, [
                'research',
                'consensus',
                'architecture_decision',
                'specification',
                'decomposition',
                'implementation',
                'validation',
                'testing',
                'release',
              ]),
            ),
          ),
        )
        .run();
    }
  }

  // ------------------------------------------------------------------
  // 5. Write idempotency guard (unless dryRun)
  // ------------------------------------------------------------------

  if (!dryRun) {
    const guardValue = JSON.stringify({
      ranAt: new Date().toISOString(),
      tasksUpdated: changes.length,
      task: 'T871',
    });

    // INSERT OR REPLACE so force-mode re-runs still update the timestamp.
    await db
      .insert(schema.schemaMeta)
      .values({ key: TERMINAL_BACKFILL_KEY, value: guardValue })
      .onConflictDoUpdate({
        target: schema.schemaMeta.key,
        set: { value: guardValue },
      })
      .run();
  }

  return {
    alreadyRun: false,
    dryRun,
    tasksScanned,
    tasksUpdated: changes.length,
    changes,
  };
}

/**
 * Check whether the terminal-stage backfill has already been applied.
 *
 * @param cwd - Project working directory passed through to getDb.
 * @returns True if the backfill ran successfully in a previous call.
 *
 * @task T871
 */
export async function isTerminalPipelineStageBackfillDone(cwd?: string): Promise<boolean> {
  const db = await getDb(cwd);
  const guard = await db
    .select()
    .from(schema.schemaMeta)
    .where(eq(schema.schemaMeta.key, TERMINAL_BACKFILL_KEY))
    .limit(1)
    .all();
  return guard.length > 0;
}
