/**
 * One-shot backfill: align `tasks.pipeline_stage` with `lifecycle_stages` for
 * epics whose lifecycle was advanced before T832 shipped the dual-write in
 * `recordStageProgress`.
 *
 * Problem (T869):
 *   - T832 added a dual-write so `recordStageProgress` updates BOTH
 *     `lifecycle_stages` AND `tasks.pipeline_stage` atomically.
 *   - Epics advanced BEFORE that change have `lifecycle_stages.stage_name` at
 *     (e.g.) 'release' while `tasks.pipeline_stage` is stuck at 'research' (the
 *     default on epic creation).
 *   - That mismatch causes E_VALIDATION on forward-only checks and
 *     E_LIFECYCLE_GATE_FAILED on child completions — a deadlock.
 *
 * Solution:
 *   For every task where:
 *     a) A lifecycle pipeline + stages entry exists with status IN
 *        ('completed', 'in_progress', 'skipped')
 *     b) The highest such stage by sequence is AFTER task.pipeline_stage
 *   Set task.pipeline_stage to the highest qualifying stage.
 *
 * Idempotency:
 *   Guarded by the `schema_meta` row with key
 *   `'backfill:pipeline-stage-from-lifecycle'`.  Running twice is a no-op.
 *
 * @task T869
 * @adr ADR-051 Decision 5
 */

import { eq, inArray } from 'drizzle-orm';
import { getDb } from '../store/sqlite.js';
import * as schema from '../store/tasks-schema.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** schema_meta key that records the backfill as run. */
export const BACKFILL_KEY = 'backfill:pipeline-stage-from-lifecycle';

/** Stage sequence map (1-based). Matches TASK_PIPELINE_STAGES order. */
const STAGE_ORDER: Record<string, number> = {
  research: 1,
  consensus: 2,
  architecture_decision: 3,
  specification: 4,
  decomposition: 5,
  implementation: 6,
  validation: 7,
  testing: 8,
  release: 9,
  contribution: 10,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-task change record returned in the result summary. */
export interface PipelineStageBackfillChange {
  /** Task ID that was updated. */
  taskId: string;
  /** Stage that was previously stored in task.pipeline_stage (null = never set). */
  previousStage: string | null;
  /** Stage applied by the backfill (highest completed/in_progress stage in lifecycle_stages). */
  newStage: string;
}

/** Overall result returned by {@link backfillPipelineStageFromLifecycle}. */
export interface PipelineStageBackfillResult {
  /** If true, the backfill had already run in a previous call — no work done. */
  alreadyRun: boolean;
  /** If true, no changes were written (preview mode). */
  dryRun: boolean;
  /** Number of tasks inspected. */
  tasksScanned: number;
  /** Number of tasks whose pipeline_stage was (or would be) updated. */
  tasksUpdated: number;
  /** Per-task detail of what changed. */
  changes: PipelineStageBackfillChange[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Backfill `tasks.pipeline_stage` from `lifecycle_stages` for tasks where they
 * diverge because the lifecycle was advanced before T832 dual-write shipped.
 *
 * @remarks
 * The migration is idempotent: a `schema_meta` row with key
 * {@link BACKFILL_KEY} is written on first success and checked on every
 * subsequent call.
 *
 * @param options - Optional overrides
 * @param options.dryRun - When true, compute changes but do not write to DB.
 * @param options.force  - When true, ignore the idempotency guard and re-run.
 * @param cwd - Project working directory (passed through to getDb).
 * @returns Summary of what was (or would be) changed.
 *
 * @example
 * ```ts
 * const result = await backfillPipelineStageFromLifecycle({ dryRun: true });
 * console.log(result.tasksUpdated); // number of diverged tasks
 * ```
 */
export async function backfillPipelineStageFromLifecycle(
  options: { dryRun?: boolean; force?: boolean } = {},
  cwd?: string,
): Promise<PipelineStageBackfillResult> {
  const { dryRun = false, force = false } = options;
  const db = await getDb(cwd);

  // ------------------------------------------------------------------
  // 1. Idempotency check
  // ------------------------------------------------------------------
  if (!force) {
    const guard = await db
      .select()
      .from(schema.schemaMeta)
      .where(eq(schema.schemaMeta.key, BACKFILL_KEY))
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
  // 2. Find all tasks that have at least one lifecycle_stages row with a
  //    status that should advance pipeline_stage.
  //
  //    We join tasks → lifecycle_pipelines → lifecycle_stages and collect
  //    the highest-sequence stage row per task where status is
  //    'completed', 'in_progress', or 'skipped'.
  //
  //    Then filter to rows where that highest stage is AFTER the task's
  //    current pipeline_stage (or pipeline_stage is NULL).
  // ------------------------------------------------------------------

  // Fetch all (taskId, stageName, sequence, status) rows for relevant statuses.
  const advancingStatuses: (typeof schema.LIFECYCLE_STAGE_STATUSES)[number][] = [
    'completed',
    'in_progress',
    'skipped',
  ];

  const rows = await db
    .select({
      taskId: schema.lifecyclePipelines.taskId,
      stageName: schema.lifecycleStages.stageName,
      sequence: schema.lifecycleStages.sequence,
      status: schema.lifecycleStages.status,
      currentPipelineStage: schema.tasks.pipelineStage,
    })
    .from(schema.lifecyclePipelines)
    .innerJoin(
      schema.lifecycleStages,
      eq(schema.lifecycleStages.pipelineId, schema.lifecyclePipelines.id),
    )
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.lifecyclePipelines.taskId))
    .where(inArray(schema.lifecycleStages.status, advancingStatuses))
    .all();

  // ------------------------------------------------------------------
  // 3. Compute per-task highest qualifying stage
  // ------------------------------------------------------------------

  /** map: taskId → { stageName, sequence, currentPipelineStage } */
  const highestPerTask = new Map<
    string,
    {
      stageName: string;
      sequence: number;
      currentPipelineStage: string | null;
    }
  >();

  for (const row of rows) {
    const existing = highestPerTask.get(row.taskId);
    if (!existing || row.sequence > existing.sequence) {
      highestPerTask.set(row.taskId, {
        stageName: row.stageName,
        sequence: row.sequence,
        currentPipelineStage: row.currentPipelineStage ?? null,
      });
    }
  }

  // ------------------------------------------------------------------
  // 4. Filter to tasks where lifecycle stage is AHEAD of task.pipeline_stage
  // ------------------------------------------------------------------

  const changes: PipelineStageBackfillChange[] = [];

  for (const [taskId, { stageName, sequence, currentPipelineStage }] of highestPerTask) {
    const currentOrder = currentPipelineStage ? (STAGE_ORDER[currentPipelineStage] ?? 0) : 0;

    // Only backfill when the lifecycle stage is strictly ahead.
    if (sequence > currentOrder) {
      changes.push({
        taskId,
        previousStage: currentPipelineStage,
        newStage: stageName,
      });
    }
  }

  const tasksScanned = highestPerTask.size;

  // ------------------------------------------------------------------
  // 5. Apply updates (unless dryRun)
  // ------------------------------------------------------------------

  if (!dryRun && changes.length > 0) {
    const now = new Date().toISOString();

    for (const change of changes) {
      await db
        .update(schema.tasks)
        .set({
          pipelineStage: change.newStage,
          updatedAt: now,
        })
        .where(eq(schema.tasks.id, change.taskId))
        .run();
    }
  }

  // ------------------------------------------------------------------
  // 6. Write idempotency guard (unless dryRun)
  // ------------------------------------------------------------------

  if (!dryRun) {
    const guardValue = JSON.stringify({
      ranAt: new Date().toISOString(),
      tasksUpdated: changes.length,
      task: 'T869',
    });

    // INSERT OR REPLACE so force-mode re-runs still update the timestamp.
    await db
      .insert(schema.schemaMeta)
      .values({ key: BACKFILL_KEY, value: guardValue })
      .onConflictDoUpdate({ target: schema.schemaMeta.key, set: { value: guardValue } })
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
 * Check whether the pipeline-stage backfill has already been applied.
 *
 * @param cwd - Project working directory passed through to getDb.
 * @returns True if the backfill ran successfully in a previous call.
 */
export async function isPipelineStageBackfillDone(cwd?: string): Promise<boolean> {
  const db = await getDb(cwd);
  const guard = await db
    .select()
    .from(schema.schemaMeta)
    .where(eq(schema.schemaMeta.key, BACKFILL_KEY))
    .limit(1)
    .all();
  return guard.length > 0;
}
