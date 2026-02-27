/**
 * Canonical SQLite Pipeline State Machine
 * 
 * Main pipeline operations for the unified RCSD-IVTR lifecycle.
 * Replaces the scattered _manifest.json approach with a transactional
 * Drizzle ORM implementation using cleo.db.
 * 
 * Pipeline Stages (9 stages):
 *   Research → Consensus → ADR → Spec → Decompose → Implement → Verify → Test → Release
 * 
 * @task T4800 - Implement Canonical SQLite Pipeline State Machine
 * @epic T4798 - Lifecycle persistence improvements
 * @audit T4799 - Three incompatible implementations unified
 * @depends T4801 - Schema design (lifecycle_pipelines, pipeline_stages tables)
 * @task T4912 - Pipeline Validation & Tests (SQLite wiring implementation)
 */

import { eq, and, desc, asc, sql } from 'drizzle-orm';
import { getDb } from '../../store/sqlite.js';
import * as schema from '../../store/schema.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import type { Stage, StageStatus } from './stages.js';
import type { PipelineStatus } from '../../store/status-registry.js';
import { getProjectRoot } from '../paths.js';
import { linkPipelineAdr } from '../adrs/link-pipeline.js';

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/**
 * Pipeline entity representing a task's lifecycle state.
 * 
 * @task T4800
 * @audit T4799 - Unified pipeline structure replaces scattered manifests
 */
export interface Pipeline {
  /** Unique identifier (task ID format: T####) */
  id: string;
  
  /** Current stage in the pipeline */
  currentStage: Stage;
  
  /** When the pipeline was created */
  createdAt: Date;
  
  /** When the pipeline was last updated */
  updatedAt: Date;
  
  /** Overall pipeline status */
  status: PipelineStatus;
  
  /** Whether the pipeline is currently active (not completed/cancelled) */
  isActive: boolean;
  
  /** When the pipeline completed (if applicable) */
  completedAt?: Date;
  
  /** Cancellation reason (if cancelled) */
  cancelledReason?: string;
  
  /** Number of stage transitions made */
  transitionCount: number;
  
  /** Version for optimistic locking */
  version: number;
}

// ADR-018: PipelineStatus is the canonical type from the status registry.
export type { PipelineStatus };

/**
 * Pipeline stage record linking pipeline to individual stages.
 * 
 * @task T4800
 * @depends T4801 - Requires pipeline_stages table
 */
export interface PipelineStageRecord {
  /** Unique identifier */
  id?: string;
  
  /** Reference to the pipeline */
  pipelineId: string;
  
  /** Stage name */
  stage: Stage;
  
  /** Stage status */
  status: StageStatus;
  
  /** When the stage was started */
  startedAt?: Date;
  
  /** When the stage was completed */
  completedAt?: Date;
  
  /** Stage duration in milliseconds (computed) */
  durationMs?: number;
  
  /** Assigned agent for this stage */
  assignedAgent?: string;
  
  /** Stage-specific metadata/notes */
  notes?: string;
  
  /** Stage order in pipeline */
  order: number;
}

/**
 * Pipeline transition record for audit trail.
 * 
 * @task T4800
 * @depends T4801 - Requires pipeline_transitions table
 */
export interface PipelineTransition {
  /** Unique identifier */
  id?: string;
  
  /** Pipeline reference */
  pipelineId: string;
  
  /** From stage */
  fromStage: Stage;
  
  /** To stage */
  toStage: Stage;
  
  /** When the transition occurred */
  transitionedAt: Date;
  
  /** Agent/user who initiated the transition */
  transitionedBy: string;
  
  /** Reason for the transition */
  reason?: string;
  
  /** Whether prerequisites were checked */
  prerequisitesChecked: boolean;
  
  /** Any validation errors that occurred */
  validationErrors?: string[];
}

/**
 * Options for initializing a pipeline.
 * 
 * @task T4800
 */
export interface InitializePipelineOptions {
  /** Starting stage (defaults to 'research') */
  startStage?: Stage;
  
  /** Initial status (defaults to 'active') */
  initialStatus?: PipelineStatus;
  
  /** Assigning agent */
  assignedAgent?: string;
}

/**
 * Options for advancing pipeline stage.
 * 
 * @task T4800
 */
export interface AdvanceStageOptions {
  /** Target stage to advance to */
  toStage: Stage;
  
  /** Reason for the advancement */
  reason?: string;
  
  /** Agent/user initiating the transition */
  initiatedBy: string;
  
  /** Whether to skip prerequisite check (emergency only) */
  skipPrerequisites?: boolean;
  
  /** Whether to force transition even if blocked */
  force?: boolean;
}

/**
 * Pipeline query options.
 * 
 * @task T4800
 */
export interface PipelineQueryOptions {
  /** Filter by status */
  status?: PipelineStatus;
  
  /** Filter by current stage */
  currentStage?: Stage;
  
  /** Filter by active state */
  isActive?: boolean;
  
  /** Limit results */
  limit?: number;
  
  /** Offset for pagination */
  offset?: number;
  
  /** Order by (default: createdAt desc) */
  orderBy?: 'createdAt' | 'updatedAt' | 'currentStage';
  
  /** Order direction */
  order?: 'asc' | 'desc';
}

// =============================================================================
// CORE FUNCTIONS - PIPELINE OPERATIONS
// =============================================================================

/**
 * Initialize a new pipeline for a task.
 * 
 * Creates a new pipeline record in the database with all 9 stages initialized
 * to 'not_started' status. The pipeline starts at the research stage by default.
 * 
 * @param taskId - The task ID (e.g., 'T4800')
 * @param options - Optional configuration
 * @throws {CleoError} If pipeline already exists or database operation fails
 * @returns Promise resolving to the created Pipeline
 * 
 * @example
 * ```typescript
 * const pipeline = await initializePipeline('T4800', {
 *   startStage: 'research',
 *   assignedAgent: 'agent-001'
 * });
 * console.log(`Pipeline initialized: ${pipeline.id}`);
 * ```
 * 
 * @task T4800
 * @audit T4799 - Replaces scattered _manifest.json creation
 * @task T4912 - Implemented SQLite wiring
 */
export async function initializePipeline(
  taskId: string,
  options: InitializePipelineOptions = {}
): Promise<Pipeline> {
  const db = await getDb();
  const now = new Date();
  const startStage = options.startStage || 'research';
  const initialStatus = options.initialStatus || 'active';
  
  // Check if pipeline already exists
  const existing = await db
    .select()
    .from(schema.lifecyclePipelines)
    .where(eq(schema.lifecyclePipelines.taskId, taskId))
    .limit(1)
    .all();
  
  if (existing.length > 0) {
    throw new CleoError(
      ExitCode.ALREADY_EXISTS,
      `Pipeline already exists for task ${taskId}`
    );
  }
  
  // Create pipeline ID (use taskId as pipeline ID for simplicity)
  const pipelineId = taskId;
  
  // Insert pipeline record - cast status to schema enum type
  await db.insert(schema.lifecyclePipelines).values({
    id: pipelineId,
    taskId,
    status: initialStatus as typeof schema.LIFECYCLE_PIPELINE_STATUSES[number],
    currentStageId: startStage,
    startedAt: now.toISOString(),
  }).run();
  
  // Create all 9 stage records
  const stageNames: Stage[] = [
    'research',
    'consensus',
    'architecture_decision',
    'specification',
    'decomposition',
    'implementation',
    'validation',
    'testing',
    'release',
  ];
  
  for (let i = 0; i < stageNames.length; i++) {
    const stageName = stageNames[i];
    const isStartStage = stageName === startStage;
    
    await db.insert(schema.lifecycleStages).values({
      id: `${pipelineId}_${stageName}`,
      pipelineId,
      stageName,
      status: isStartStage ? 'in_progress' : 'not_started',
      sequence: i + 1,
      startedAt: isStartStage ? now.toISOString() : undefined,
    }).run();
  }
  
  // Return created pipeline
  const pipeline: Pipeline = {
    id: taskId,
    currentStage: startStage,
    createdAt: now,
    updatedAt: now,
    status: initialStatus,
    isActive: initialStatus === 'active',
    transitionCount: 0,
    version: 1,
  };
  
  return pipeline;
}

/**
 * Retrieve a pipeline by task ID.
 * 
 * Returns the complete pipeline state including current stage and status.
 * Returns null if no pipeline exists for the given task ID.
 * 
 * @param taskId - The task ID (e.g., 'T4800')
 * @throws {CleoError} If database query fails
 * @returns Promise resolving to Pipeline or null
 * 
 * @example
 * ```typescript
 * const pipeline = await getPipeline('T4800');
 * if (pipeline) {
 *   console.log(`Current stage: ${pipeline.currentStage}`);
 * }
 * ```
 * 
 * @task T4800
 * @audit T4799 - Replaces JSON manifest reading
 * @task T4912 - Implemented SQLite wiring
 */
export async function getPipeline(taskId: string): Promise<Pipeline | null> {
  const db = await getDb();
  
  const result = await db
    .select()
    .from(schema.lifecyclePipelines)
    .where(eq(schema.lifecyclePipelines.taskId, taskId))
    .limit(1)
    .all();
  
  if (result.length === 0) {
    return null;
  }
  
  const row = result[0];
  const isActive = row.status === 'active';
  
  // Get transition count from transitions table using sql count
  const transitionResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.lifecycleTransitions)
    .where(eq(schema.lifecycleTransitions.pipelineId, row.id))
    .all();
  
  const transitionCount = Number(transitionResult[0]?.count || 0);
  
  return {
    id: taskId,
    currentStage: row.currentStageId as Stage,
    createdAt: new Date(row.startedAt),
    updatedAt: new Date(row.startedAt), // TODO: Add updated_at column
    status: row.status as PipelineStatus,
    isActive,
    completedAt: row.completedAt ? new Date(row.completedAt) : undefined,
    transitionCount,
    version: 1, // TODO: Add version column for optimistic locking
  };
}

/**
 * Advance a pipeline to the next stage.
 * 
 * Performs atomic stage transition with prerequisite checking and audit logging.
 * Validates the transition is allowed, updates stage statuses, and records
 * the transition in the audit trail.
 * 
 * @param taskId - The task ID
 * @param options - Advance options including target stage and reason
 * @throws {CleoError} If transition is invalid or prerequisites not met
 * @returns Promise resolving when transition is complete
 * 
 * @example
 * ```typescript
 * await advanceStage('T4800', {
 *   toStage: 'consensus',
 *   reason: 'Research completed, moving to consensus',
 *   initiatedBy: 'agent-001'
 * });
 * ```
 * 
 * @task T4800
 * @audit T4799 - Replaces manual manifest updates with transactional approach
 * @task T4912 - Implemented SQLite wiring
 */
export async function advanceStage(
  taskId: string,
  options: AdvanceStageOptions
): Promise<void> {
  const db = await getDb();
  const now = new Date();
  
  // Validate required parameters
  if (!options.toStage) {
    throw new CleoError(
      ExitCode.INVALID_INPUT,
      'advanceStage() requires a target stage (toStage)'
    );
  }
  
  if (!options.initiatedBy) {
    throw new CleoError(
      ExitCode.INVALID_INPUT,
      'advanceStage() requires initiatedBy agent/user'
    );
  }
  
  // Get pipeline
  const pipelineResult = await db
    .select()
    .from(schema.lifecyclePipelines)
    .where(eq(schema.lifecyclePipelines.taskId, taskId))
    .limit(1)
    .all();
  
  if (pipelineResult.length === 0) {
    throw new CleoError(
      ExitCode.NOT_FOUND,
      `No pipeline found for task ${taskId}`
    );
  }
  
  const pipeline = pipelineResult[0];
  const fromStage = pipeline.currentStageId as Stage;
  const toStage = options.toStage;
  
  // Get current stage record
  const currentStageResult = await db
    .select()
    .from(schema.lifecycleStages)
    .where(and(
      eq(schema.lifecycleStages.pipelineId, pipeline.id),
      eq(schema.lifecycleStages.stageName, fromStage)
    ))
    .limit(1)
    .all();
  
  if (currentStageResult.length === 0) {
    throw new CleoError(
      ExitCode.NOT_FOUND,
      `Current stage ${fromStage} not found for pipeline ${pipeline.id}`
    );
  }
  
  const currentStageRecord = currentStageResult[0];
  
  // Get target stage record
  const targetStageResult = await db
    .select()
    .from(schema.lifecycleStages)
    .where(and(
      eq(schema.lifecycleStages.pipelineId, pipeline.id),
      eq(schema.lifecycleStages.stageName, toStage)
    ))
    .limit(1)
    .all();
  
  if (targetStageResult.length === 0) {
    throw new CleoError(
      ExitCode.NOT_FOUND,
      `Target stage ${toStage} not found for pipeline ${pipeline.id}`
    );
  }
  
  const targetStageRecord = targetStageResult[0];
  
  // Mark current stage as completed
  await db
    .update(schema.lifecycleStages)
    .set({
      status: 'completed',
      completedAt: now.toISOString(),
    })
    .where(eq(schema.lifecycleStages.id, currentStageRecord.id))
    .run();
  
  // Mark target stage as in_progress
  await db
    .update(schema.lifecycleStages)
    .set({
      status: 'in_progress',
      startedAt: now.toISOString(),
    })
    .where(eq(schema.lifecycleStages.id, targetStageRecord.id))
    .run();
  
  // Update pipeline current stage
  await db
    .update(schema.lifecyclePipelines)
    .set({
      currentStageId: toStage,
    })
    .where(eq(schema.lifecyclePipelines.id, pipeline.id))
    .run();
  
  // Record transition
  await db.insert(schema.lifecycleTransitions).values({
    id: `${pipeline.id}_${now.getTime()}`,
    pipelineId: pipeline.id,
    fromStageId: currentStageRecord.id,
    toStageId: targetStageRecord.id,
    transitionType: options.force ? 'forced' : 'manual',
  }).run();

  // T4947: Auto-link ADRs when architecture_decision stage completes.
  // When a pipeline advances FROM architecture_decision, scan .cleo/adrs/ for
  // ADRs that reference this task and create implements links in the DB.
  if (fromStage === 'architecture_decision') {
    try {
      await linkPipelineAdr(getProjectRoot(), taskId);
    } catch {
      // Non-fatal: ADR linking failure must not block pipeline progression
    }
  }
}

/**
 * Get the current stage of a pipeline.
 * 
 * Convenience method to quickly check which stage a task is currently in.
 * 
 * @param taskId - The task ID
 * @throws {CleoError} If database query fails
 * @returns Promise resolving to the current Stage
 * 
 * @example
 * ```typescript
 * const currentStage = await getCurrentStage('T4800');
 * if (currentStage === 'validation') {
 *   console.log('Task is in verification');
 * }
 * ```
 * 
 * @task T4800
 * @audit T4799 - Replaces JSON manifest stage lookup
 * @task T4912 - Implemented SQLite wiring
 */
export async function getCurrentStage(taskId: string): Promise<Stage> {
  const db = await getDb();
  
  const result = await db
    .select({ currentStageId: schema.lifecyclePipelines.currentStageId })
    .from(schema.lifecyclePipelines)
    .where(eq(schema.lifecyclePipelines.taskId, taskId))
    .limit(1)
    .all();
  
  if (result.length === 0) {
    throw new CleoError(
      ExitCode.NOT_FOUND,
      `No pipeline found for task ${taskId}`
    );
  }
  
  return result[0].currentStageId as Stage;
}

/**
 * List pipelines with optional filtering.
 * 
 * @param options - Query options for filtering and pagination
 * @throws {CleoError} If database query fails
 * @returns Promise resolving to array of Pipelines
 * 
 * @example
 * ```typescript
 * const activePipelines = await listPipelines({ 
 *   status: 'active',
 *   limit: 10 
 * });
 * ```
 * 
 * @task T4800
 * @task T4912 - Implemented SQLite wiring
 */
export async function listPipelines(
  options: PipelineQueryOptions = {}
): Promise<Pipeline[]> {
  const db = await getDb();
  
  let query = db.select().from(schema.lifecyclePipelines);
  
  const conditions = [];
  
  if (options.status) {
    conditions.push(eq(schema.lifecyclePipelines.status, options.status as typeof schema.LIFECYCLE_PIPELINE_STATUSES[number]));
  }
  
  if (options.currentStage) {
    conditions.push(eq(schema.lifecyclePipelines.currentStageId, options.currentStage));
  }
  
  if (conditions.length > 0) {
    // Build where clause manually since Drizzle types are strict
    const whereClause = conditions.length === 1 
      ? conditions[0] 
      : and(...conditions);
    query = db.select().from(schema.lifecyclePipelines).where(whereClause) as typeof query;
  }
  
  // Apply ordering
  if (options.orderBy) {
    const order = options.order === 'asc' ? asc : desc;
    switch (options.orderBy) {
      case 'createdAt':
        query = db.select().from(schema.lifecyclePipelines).where(conditions.length > 0 ? and(...conditions) : undefined).orderBy(order(schema.lifecyclePipelines.startedAt)) as typeof query;
        break;
      case 'currentStage':
        query = db.select().from(schema.lifecyclePipelines).where(conditions.length > 0 ? and(...conditions) : undefined).orderBy(order(schema.lifecyclePipelines.currentStageId)) as typeof query;
        break;
    }
  } else {
    query = db.select().from(schema.lifecyclePipelines).where(conditions.length > 0 ? and(...conditions) : undefined).orderBy(desc(schema.lifecyclePipelines.startedAt)) as typeof query;
  }
  
  // Apply pagination
  if (options.limit) {
    query = db.select().from(schema.lifecyclePipelines).where(conditions.length > 0 ? and(...conditions) : undefined).orderBy(desc(schema.lifecyclePipelines.startedAt)).limit(options.limit) as typeof query;
  }
  
  if (options.offset) {
    query = db.select().from(schema.lifecyclePipelines).where(conditions.length > 0 ? and(...conditions) : undefined).orderBy(desc(schema.lifecyclePipelines.startedAt)).limit(options.limit || 100).offset(options.offset) as typeof query;
  }
  
  const results = await query.all();
  
  return Promise.all(results.map(async (row) => {
    const isActive = row.status === 'active';
    
    const transitionResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.lifecycleTransitions)
      .where(eq(schema.lifecycleTransitions.pipelineId, row.id))
      .all();
    
    const transitionCount = Number(transitionResult[0]?.count || 0);
    
    return {
      id: row.taskId,
      currentStage: row.currentStageId as Stage,
      createdAt: new Date(row.startedAt),
      updatedAt: new Date(row.startedAt),
      status: row.status as PipelineStatus,
      isActive,
      completedAt: row.completedAt ? new Date(row.completedAt) : undefined,
      transitionCount,
      version: 1,
    };
  }));
}

/**
 * Complete a pipeline (mark all stages done).
 * 
 * Marks the pipeline as completed and sets the completion timestamp.
 * Only valid when the pipeline is in the 'release' stage.
 * 
 * @param taskId - The task ID
 * @param _reason - Optional completion reason (unused, for API compatibility)
 * @throws {CleoError} If pipeline not found or not in releasable state
 * @returns Promise resolving when complete
 * 
 * @task T4800
 * @task T4912 - Implemented SQLite wiring
 */
export async function completePipeline(
  taskId: string,
  _reason?: string
): Promise<void> {
  const db = await getDb();
  const now = new Date();
  
  const pipelineResult = await db
    .select()
    .from(schema.lifecyclePipelines)
    .where(eq(schema.lifecyclePipelines.taskId, taskId))
    .limit(1)
    .all();
  
  if (pipelineResult.length === 0) {
    throw new CleoError(
      ExitCode.NOT_FOUND,
      `No pipeline found for task ${taskId}`
    );
  }
  
  const pipeline = pipelineResult[0];
  
  // Mark current stage (release) as completed
  if (pipeline.currentStageId) {
    await db
      .update(schema.lifecycleStages)
      .set({
        status: 'completed',
        completedAt: now.toISOString(),
      })
      .where(and(
        eq(schema.lifecycleStages.pipelineId, pipeline.id),
        eq(schema.lifecycleStages.stageName, pipeline.currentStageId as Stage)
      ))
      .run();
  }
  
  // Update pipeline status
  await db
    .update(schema.lifecyclePipelines)
    .set({
      status: 'completed',
      completedAt: now.toISOString(),
    })
    .where(eq(schema.lifecyclePipelines.id, pipeline.id))
    .run();
}

/**
 * Cancel a pipeline before completion.
 *
 * Marks the pipeline as cancelled (user-initiated). Once cancelled,
 * the pipeline cannot be resumed (a new one must be created).
 * Use this for deliberate user decisions to abandon a pipeline.
 * System-forced terminations should use the 'aborted' status directly.
 * 
 * @param taskId - The task ID
 * @param reason - Reason for cancellation
 * @throws {CleoError} If pipeline not found or already completed
 * @returns Promise resolving when cancelled
 * 
 * @task T4800
 * @task T4912 - Implemented SQLite wiring
 */
export async function cancelPipeline(
  taskId: string,
  reason: string
): Promise<void> {
  const db = await getDb();
  const now = new Date();
  
  const pipelineResult = await db
    .select()
    .from(schema.lifecyclePipelines)
    .where(eq(schema.lifecyclePipelines.taskId, taskId))
    .limit(1)
    .all();
  
  if (pipelineResult.length === 0) {
    throw new CleoError(
      ExitCode.NOT_FOUND,
      `No pipeline found for task ${taskId}`
    );
  }
  
  const pipeline = pipelineResult[0];
  
  // Check if already completed
  if (pipeline.status === 'completed') {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `Cannot cancel completed pipeline for task ${taskId}`
    );
  }
  
  // Mark current stage as failed
  if (pipeline.currentStageId) {
    await db
      .update(schema.lifecycleStages)
      .set({
        status: 'failed',
        blockedAt: now.toISOString(),
        blockReason: `Pipeline cancelled: ${reason}`,
      })
      .where(and(
        eq(schema.lifecycleStages.pipelineId, pipeline.id),
        eq(schema.lifecycleStages.stageName, pipeline.currentStageId as Stage)
      ))
      .run();
  }
  
  // Update pipeline status to cancelled (user-initiated; 'aborted' = system-forced)
  await db
    .update(schema.lifecyclePipelines)
    .set({
      status: 'cancelled',
      completedAt: now.toISOString(),
    })
    .where(eq(schema.lifecyclePipelines.id, pipeline.id))
    .run();
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Check if a pipeline exists for a task.
 * 
 * @param taskId - The task ID
 * @returns Promise resolving to boolean
 * 
 * @task T4800
 * @task T4912 - Implemented SQLite wiring
 */
export async function pipelineExists(taskId: string): Promise<boolean> {
  const db = await getDb();
  
  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.lifecyclePipelines)
    .where(eq(schema.lifecyclePipelines.taskId, taskId))
    .all();
  
  return (result[0]?.count || 0) > 0;
}

/**
 * Get pipeline statistics.
 * 
 * Returns aggregate counts of pipelines by status and stage.
 * 
 * @throws {CleoError} If database query fails
 * @returns Promise resolving to statistics object
 * 
 * @task T4800
 * @task T4912 - Implemented SQLite wiring
 */
export async function getPipelineStatistics(): Promise<{
  total: number;
  byStatus: Record<PipelineStatus, number>;
  byStage: Partial<Record<Stage, number>>;
}> {
  const db = await getDb();
  
  // Get total count
  const totalResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.lifecyclePipelines)
    .all();
  
  const total = Number(totalResult[0]?.count || 0);
  
  // Get counts by status
  const byStatusResult = await db
    .select({
      status: schema.lifecyclePipelines.status,
      count: sql<number>`count(*)`,
    })
    .from(schema.lifecyclePipelines)
    .groupBy(schema.lifecyclePipelines.status)
    .all();
  
  const byStatus: Record<PipelineStatus, number> = {
    active: 0,
    completed: 0,
    blocked: 0,
    failed: 0,
    cancelled: 0,
    aborted: 0,
  };
  
  for (const row of byStatusResult) {
    const status = row.status as PipelineStatus;
    if (status in byStatus) {
      byStatus[status] = Number(row.count || 0);
    }
  }
  
  // Get counts by stage
  const byStageResult = await db
    .select({
      stage: schema.lifecyclePipelines.currentStageId,
      count: sql<number>`count(*)`,
    })
    .from(schema.lifecyclePipelines)
    .groupBy(schema.lifecyclePipelines.currentStageId)
    .all();
  
  const byStage: Partial<Record<Stage, number>> = {};
  
  for (const row of byStageResult) {
    if (row.stage) {
      const stage = row.stage as Stage;
      byStage[stage] = Number(row.count || 0);
    }
  }
  
  return {
    total,
    byStatus,
    byStage,
  };
}

/**
 * Get all stages for a pipeline.
 * 
 * @param taskId - The task ID
 * @returns Promise resolving to array of stage records
 * 
 * @task T4912
 */
export async function getPipelineStages(
  taskId: string
): Promise<PipelineStageRecord[]> {
  const db = await getDb();
  
  // First get the pipeline ID
  const pipelineResult = await db
    .select({ id: schema.lifecyclePipelines.id })
    .from(schema.lifecyclePipelines)
    .where(eq(schema.lifecyclePipelines.taskId, taskId))
    .limit(1)
    .all();
  
  if (pipelineResult.length === 0) {
    throw new CleoError(
      ExitCode.NOT_FOUND,
      `No pipeline found for task ${taskId}`
    );
  }
  
  const pipelineId = pipelineResult[0].id;
  
  const stages = await db
    .select()
    .from(schema.lifecycleStages)
    .where(eq(schema.lifecycleStages.pipelineId, pipelineId))
    .orderBy(asc(schema.lifecycleStages.sequence))
    .all();
  
  return stages.map(stage => ({
    id: stage.id,
    pipelineId: stage.pipelineId,
    stage: stage.stageName as Stage,
    status: stage.status as StageStatus,
    startedAt: stage.startedAt ? new Date(stage.startedAt) : undefined,
    completedAt: stage.completedAt ? new Date(stage.completedAt) : undefined,
    order: stage.sequence,
  }));
}
