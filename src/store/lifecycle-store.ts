/**
 * SQLite-backed lifecycle store operations.
 *
 * Query and mutation functions for lifecycle pipeline tables:
 * lifecycle_pipelines, lifecycle_stages, lifecycle_gate_results,
 * lifecycle_evidence, lifecycle_transitions.
 *
 * Used by src/core/lifecycle/resume.ts to avoid direct store-layer imports.
 *
 * @task T4832
 * @epic T4454
 */

import { eq, and, inArray, desc, asc, sql } from 'drizzle-orm';
import { getDb } from './sqlite.js';
import * as schema from './schema.js';

// =============================================================================
// QUERY TYPES (matching drizzle select shapes)
// =============================================================================

/** Row shape for pipeline + stage + task JOIN. */
export interface PipelineStageTaskRow {
  pipeline: typeof schema.lifecyclePipelines.$inferSelect;
  stage: typeof schema.lifecycleStages.$inferSelect;
  task: typeof schema.tasks.$inferSelect;
}

/** Row shape for pipeline + stage JOIN. */
export interface PipelineStageRow {
  pipeline: typeof schema.lifecyclePipelines.$inferSelect;
  stageRecord: typeof schema.lifecycleStages.$inferSelect;
}

// =============================================================================
// PIPELINE QUERIES
// =============================================================================

/**
 * Find active pipelines joined with their stages and tasks.
 * Optionally filters by specific task IDs.
 *
 * @param taskIds - Optional list of task IDs to filter by
 * @param cwd - Working directory for database
 * @returns Rows with pipeline, stage, and task data
 */
export async function findActivePipelinesWithStagesAndTasks(
  taskIds?: string[],
  cwd?: string,
): Promise<PipelineStageTaskRow[]> {
  const db = await getDb(cwd);

  const conditions = [
    eq(schema.lifecyclePipelines.status, 'active'),
  ];

  if (taskIds && taskIds.length > 0) {
    conditions.push(inArray(schema.lifecyclePipelines.taskId, taskIds));
  }

  return db
    .select({
      pipeline: schema.lifecyclePipelines,
      stage: schema.lifecycleStages,
      task: schema.tasks,
    })
    .from(schema.lifecyclePipelines)
    .innerJoin(
      schema.lifecycleStages,
      eq(schema.lifecycleStages.pipelineId, schema.lifecyclePipelines.id),
    )
    .innerJoin(
      schema.tasks,
      eq(schema.tasks.id, schema.lifecyclePipelines.taskId),
    )
    .where(and(...conditions))
    .orderBy(
      asc(schema.tasks.priority),
      desc(schema.lifecyclePipelines.startedAt),
    )
    .all();
}

/**
 * Find a pipeline with its current stage and task by taskId.
 * Matches stages where stageName equals the pipeline's currentStageId.
 *
 * @param taskId - Task ID to look up
 * @param cwd - Working directory for database
 * @returns Matching rows (typically 0 or 1)
 */
export async function findPipelineWithCurrentStageAndTask(
  taskId: string,
  cwd?: string,
): Promise<PipelineStageTaskRow[]> {
  const db = await getDb(cwd);

  return db
    .select({
      pipeline: schema.lifecyclePipelines,
      stage: schema.lifecycleStages,
      task: schema.tasks,
    })
    .from(schema.lifecyclePipelines)
    .innerJoin(
      schema.lifecycleStages,
      eq(schema.lifecycleStages.pipelineId, schema.lifecyclePipelines.id),
    )
    .innerJoin(
      schema.tasks,
      eq(schema.tasks.id, schema.lifecyclePipelines.taskId),
    )
    .where(
      and(
        eq(schema.lifecyclePipelines.taskId, taskId),
        eq(schema.lifecycleStages.stageName, sql`${schema.lifecyclePipelines.currentStageId}`),
      ),
    )
    .limit(1)
    .all();
}

/**
 * Find a pipeline and a specific stage by taskId and stageName.
 *
 * @param taskId - Task ID
 * @param stageName - Stage name to match
 * @param cwd - Working directory for database
 * @returns Matching rows (typically 0 or 1)
 */
export async function findPipelineWithStage(
  taskId: string,
  stageName: string,
  cwd?: string,
): Promise<PipelineStageRow[]> {
  const db = await getDb(cwd);

  return db
    .select({
      pipeline: schema.lifecyclePipelines,
      stageRecord: schema.lifecycleStages,
    })
    .from(schema.lifecyclePipelines)
    .innerJoin(
      schema.lifecycleStages,
      and(
        eq(schema.lifecycleStages.pipelineId, schema.lifecyclePipelines.id),
        eq(schema.lifecycleStages.stageName, stageName as typeof schema.LIFECYCLE_STAGE_NAMES[number]),
      ),
    )
    .where(eq(schema.lifecyclePipelines.taskId, taskId))
    .limit(1)
    .all();
}

/**
 * Update pipeline's currentStageId.
 *
 * @param pipelineId - Pipeline ID to update
 * @param currentStageId - New current stage identifier
 * @param cwd - Working directory for database
 */
export async function updatePipelineCurrentStage(
  pipelineId: string,
  currentStageId: string,
  cwd?: string,
): Promise<void> {
  const db = await getDb(cwd);

  await db
    .update(schema.lifecyclePipelines)
    .set({ currentStageId })
    .where(eq(schema.lifecyclePipelines.id, pipelineId))
    .run();
}

// =============================================================================
// STAGE QUERIES
// =============================================================================

/**
 * Get all stages for a pipeline, ordered by sequence.
 *
 * @param pipelineId - Pipeline ID
 * @param cwd - Working directory for database
 * @returns All stage rows for the pipeline
 */
export async function getStagesByPipelineId(
  pipelineId: string,
  cwd?: string,
): Promise<(typeof schema.lifecycleStages.$inferSelect)[]> {
  const db = await getDb(cwd);

  return db
    .select()
    .from(schema.lifecycleStages)
    .where(eq(schema.lifecycleStages.pipelineId, pipelineId))
    .orderBy(asc(schema.lifecycleStages.sequence))
    .all();
}

/**
 * Update a stage's status to 'in_progress' and clear block fields.
 *
 * @param stageId - Stage ID to update
 * @param startedAt - ISO timestamp for when the stage started
 * @param cwd - Working directory for database
 */
export async function activateStage(
  stageId: string,
  startedAt: string,
  cwd?: string,
): Promise<void> {
  const db = await getDb(cwd);

  await db
    .update(schema.lifecycleStages)
    .set({
      status: 'in_progress',
      startedAt,
      blockedAt: null,
      blockReason: null,
    })
    .where(eq(schema.lifecycleStages.id, stageId))
    .run();
}

/**
 * Find pipeline with current stage (no task join) by taskId.
 * Used by checkBlockedStageDetails.
 *
 * @param taskId - Task ID
 * @param cwd - Working directory for database
 * @returns Matching rows
 */
export async function findPipelineWithCurrentStage(
  taskId: string,
  cwd?: string,
): Promise<PipelineStageRow[]> {
  const db = await getDb(cwd);

  return db
    .select({
      pipeline: schema.lifecyclePipelines,
      stageRecord: schema.lifecycleStages,
    })
    .from(schema.lifecyclePipelines)
    .innerJoin(
      schema.lifecycleStages,
      eq(schema.lifecycleStages.pipelineId, schema.lifecyclePipelines.id),
    )
    .where(
      and(
        eq(schema.lifecyclePipelines.taskId, taskId),
        eq(schema.lifecycleStages.stageName, sql`${schema.lifecyclePipelines.currentStageId}`),
      ),
    )
    .limit(1)
    .all();
}

// =============================================================================
// GATE RESULT QUERIES
// =============================================================================

/**
 * Get gate results for a stage, ordered by checkedAt descending.
 *
 * @param stageId - Stage ID
 * @param cwd - Working directory for database
 * @returns Gate result rows
 */
export async function getGateResultsByStageId(
  stageId: string,
  cwd?: string,
): Promise<(typeof schema.lifecycleGateResults.$inferSelect)[]> {
  const db = await getDb(cwd);

  return db
    .select()
    .from(schema.lifecycleGateResults)
    .where(eq(schema.lifecycleGateResults.stageId, stageId))
    .orderBy(desc(schema.lifecycleGateResults.checkedAt))
    .all();
}

/**
 * Get gate results for a stage without ordering (for simple checks).
 *
 * @param stageId - Stage ID
 * @param cwd - Working directory for database
 * @returns Gate result rows
 */
export async function getGateResultsByStageIdUnordered(
  stageId: string,
  cwd?: string,
): Promise<(typeof schema.lifecycleGateResults.$inferSelect)[]> {
  const db = await getDb(cwd);

  return db
    .select()
    .from(schema.lifecycleGateResults)
    .where(eq(schema.lifecycleGateResults.stageId, stageId))
    .all();
}

// =============================================================================
// EVIDENCE QUERIES
// =============================================================================

/**
 * Get evidence for a stage, ordered by recordedAt descending.
 *
 * @param stageId - Stage ID
 * @param cwd - Working directory for database
 * @returns Evidence rows
 */
export async function getEvidenceByStageId(
  stageId: string,
  cwd?: string,
): Promise<(typeof schema.lifecycleEvidence.$inferSelect)[]> {
  const db = await getDb(cwd);

  return db
    .select()
    .from(schema.lifecycleEvidence)
    .where(eq(schema.lifecycleEvidence.stageId, stageId))
    .orderBy(desc(schema.lifecycleEvidence.recordedAt))
    .all();
}

// =============================================================================
// TRANSITION QUERIES & MUTATIONS
// =============================================================================

/**
 * Get recent transitions for a pipeline, ordered by createdAt descending.
 *
 * @param pipelineId - Pipeline ID
 * @param limit - Max rows to return (default: 10)
 * @param cwd - Working directory for database
 * @returns Transition rows
 */
export async function getRecentTransitions(
  pipelineId: string,
  limit: number = 10,
  cwd?: string,
): Promise<(typeof schema.lifecycleTransitions.$inferSelect)[]> {
  const db = await getDb(cwd);

  return db
    .select()
    .from(schema.lifecycleTransitions)
    .where(eq(schema.lifecycleTransitions.pipelineId, pipelineId))
    .orderBy(desc(schema.lifecycleTransitions.createdAt))
    .limit(limit)
    .all();
}

/**
 * Insert a new transition record.
 *
 * @param transition - Transition data to insert
 * @param cwd - Working directory for database
 */
export async function insertTransition(
  transition: typeof schema.lifecycleTransitions.$inferInsert,
  cwd?: string,
): Promise<void> {
  const db = await getDb(cwd);

  await db
    .insert(schema.lifecycleTransitions)
    .values(transition)
    .run();
}
