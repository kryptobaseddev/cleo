/**
 * Cross-Session Pipeline Resume Flow
 *
 * Enables automated cross-session pipeline resume using the SQLite lifecycle schema.
 * Integrates with session initialization to check for and present resumable work.
 *
 * @task T4805 - Implement SQLite-backed Cross-Session Resume Flow
 * @epic T4798 - Lifecycle persistence improvements
 * @ref T4801 - SQLite schema with lifecycle tables
 * @ref T4800 - Pipeline state machine
 * @ref T4804 - Gate/evidence recording stubs
 * @ref T4798 - RCASD-IVTR+C lifecycle
 *
 * Functions:
 * - findResumablePipelines(): Query active pipelines from SQLite
 * - loadPipelineContext(): Load stage context via SQL JOINs
 * - resumeStage(): Resume a specific stage
 * - autoResume(): Auto-detect where to resume
 *
 * Usage:
 * ```typescript
 * import { findResumablePipelines, autoResume } from './resume.js';
 *
 * // Check for resumable work on session start
 * const resumable = await findResumablePipelines();
 * if (resumable.length > 0) {
 *   console.log(`Found ${resumable.length} resumable pipelines`);
 * }
 *
 * // Auto-detect resume point
 * const resumePoint = await autoResume();
 * if (resumePoint.canResume) {
 *   await resumeStage(resumePoint.taskId, resumePoint.stage);
 * }
 * ```
 */

import { eq, and, inArray, desc, asc, sql as drizzleSql } from 'drizzle-orm';
import { getDb } from '../../store/sqlite.js';
import * as schema from '../../store/schema.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import type { Stage } from './stages.js';
import { validateStage, getNextStage } from './stages.js';

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

import type { StageStatus as DbStageStatus, PipelineStatus } from '../../store/status-registry.js';
import { STAGE_STATUS_ICONS } from '../../store/status-registry.js';

/**
 * Resumable pipeline information returned to callers.
 *
 * @task T4805
 * @ref T4798
 */
export interface ResumablePipeline {
  /** Task ID (e.g., T4805) */
  taskId: string;

  /** Pipeline ID */
  pipelineId: string;

  /** Current stage in the pipeline */
  currentStage: Stage;

  /** Pipeline status */
  status: PipelineStatus;

  /** When the pipeline started */
  startedAt: Date;

  /** When the pipeline was last updated */
  updatedAt: Date;

  /** Task title */
  taskTitle: string;

  /** Current stage status */
  stageStatus: DbStageStatus;

  /** Stage started at (if active) */
  stageStartedAt?: Date;

  /** Block reason if blocked */
  blockReason?: string;

  /** Previous session ID if known */
  previousSessionId?: string;

  /** Resume priority (lower = higher priority) */
  resumePriority: number;
}

/**
 * Pipeline context for session resume.
 *
 * @task T4805
 */
export interface PipelineContext {
  /** Task ID */
  taskId: string;

  /** Pipeline ID */
  pipelineId: string;

  /** Current stage */
  currentStage: Stage;

  /** All stages with their status */
  stages: StageContext[];

  /** Gate results for current stage */
  gateResults: GateResultContext[];

  /** Evidence linked to current stage */
  evidence: EvidenceContext[];

  /** Recent transitions */
  recentTransitions: TransitionContext[];

  /** Task details */
  task: TaskContext;
}

/**
 * Stage context within a pipeline.
 *
 * @task T4805
 */
export interface StageContext {
  /** Stage name */
  stage: Stage;

  /** Stage status */
  status: DbStageStatus;

  /** Sequence order */
  sequence: number;

  /** When started */
  startedAt?: Date;

  /** When completed */
  completedAt?: Date;

  /** Block information */
  blockedAt?: Date;
  blockReason?: string;

  /** Skip information */
  skippedAt?: Date;
  skipReason?: string;

  /** Stage notes */
  notes: string[];

  /** Stage metadata */
  metadata: Record<string, unknown>;
}

/**
 * Gate result context.
 *
 * @task T4805
 * @ref T4804
 */
export interface GateResultContext {
  /** Gate name */
  gateName: string;

  /** Result status */
  result: 'pass' | 'fail' | 'warn';

  /** When checked */
  checkedAt: Date;

  /** Who checked */
  checkedBy: string;

  /** Details */
  details?: string;

  /** Reason if failed */
  reason?: string;
}

/**
 * Evidence context.
 *
 * @task T4805
 * @ref T4804
 */
export interface EvidenceContext {
  /** Evidence ID */
  id: string;

  /** URI to evidence */
  uri: string;

  /** Evidence type */
  type: 'file' | 'url' | 'manifest';

  /** When recorded */
  recordedAt: Date;

  /** Who recorded */
  recordedBy?: string;

  /** Description */
  description?: string;
}

/**
 * Transition context.
 *
 * @task T4805
 */
export interface TransitionContext {
  /** From stage */
  fromStage: string;

  /** To stage */
  toStage: string;

  /** When transitioned */
  transitionedAt: Date;

  /** Who initiated */
  transitionedBy: string;

  /** Reason */
  reason?: string;
}

/**
 * Task context.
 *
 * @task T4805
 */
export interface TaskContext {
  /** Task ID */
  id: string;

  /** Task title */
  title: string;

  /** Task description */
  description?: string;

  /** Task status */
  status: string;

  /** Task priority */
  priority: string;

  /** Parent task ID */
  parentId?: string;
}

/**
 * Result of a resume operation.
 *
 * @task T4805
 */
export interface ResumeResult {
  /** Whether resume was successful */
  success: boolean;

  /** Task ID */
  taskId: string;

  /** Stage resumed */
  stage: Stage;

  /** Previous status */
  previousStatus: DbStageStatus;

  /** New status */
  newStatus: DbStageStatus;

  /** Resume timestamp */
  resumedAt: Date;

  /** Message for user */
  message: string;

  /** Any warnings */
  warnings: string[];
}

/**
 * Auto-resume detection result.
 *
 * @task T4805
 */
export interface AutoResumeResult {
  /** Whether auto-resume is possible */
  canResume: boolean;

  /** Task ID to resume */
  taskId?: string;

  /** Stage to resume */
  stage?: Stage;

  /** Pipeline context if available */
  context?: PipelineContext;

  /** Resume options if multiple */
  options?: ResumablePipeline[];

  /** Recommended action */
  recommendation: 'resume' | 'choose' | 'none';

  /** Message for user */
  message: string;
}

/**
 * Options for finding resumable pipelines.
 *
 * @task T4805
 */
export interface FindResumableOptions {
  /** Filter by specific task IDs */
  taskIds?: string[];

  /** Filter by stages */
  stages?: Stage[];

  /** Include blocked pipelines */
  includeBlocked?: boolean;

  /** Include aborted pipelines */
  includeAborted?: boolean;

  /** Maximum results */
  limit?: number;

  /** Minimum priority (tasks with priority >= this) */
  minPriority?: 'critical' | 'high' | 'medium' | 'low';
}

// =============================================================================
// CORE FUNCTIONS
// =============================================================================

/**
 * Query active pipelines that can be resumed.
 *
 * Searches the lifecycle_pipelines table for pipelines with status 'active'
 * and joins with lifecycle_stages to determine current stage status.
 * Also joins with tasks table to get task metadata.
 *
 * @param options - Query options for filtering
 * @param cwd - Working directory for database
 * @returns Promise resolving to array of resumable pipelines
 *
 * @example
 * ```typescript
 * // Find all active pipelines
 * const resumable = await findResumablePipelines();
 *
 * // Find specific tasks
 * const specific = await findResumablePipelines({
 *   taskIds: ['T4805', 'T4806']
 * });
 *
 * // Include blocked pipelines
 * const withBlocked = await findResumablePipelines({
 *   includeBlocked: true
 * });
 * ```
 *
 * @task T4805
 * @ref T4801 - Uses lifecycle_pipelines, lifecycle_stages tables
 */
export async function findResumablePipelines(
  options: FindResumableOptions = {},
  cwd?: string,
): Promise<ResumablePipeline[]> {
  const db = await getDb(cwd);

  // Build base query conditions
  const conditions = [
    eq(schema.lifecyclePipelines.status, 'active'),
  ];

  if (options.taskIds && options.taskIds.length > 0) {
    conditions.push(inArray(schema.lifecyclePipelines.taskId, options.taskIds));
  }

  // Query all active pipelines with their stages and tasks
  // We need to find the current stage for each pipeline
  const results = await db
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

  // Group by pipeline and find current stage for each
  const pipelineMap = new Map<string, typeof results[0]>();
  
  for (const row of results) {
    const pipelineId = row.pipeline.id;
    const currentStageId = row.pipeline.currentStageId;
    
    // If this row's stage matches the pipeline's current stage, use it
    if (currentStageId && row.stage.stageName === currentStageId) {
      pipelineMap.set(pipelineId, row);
    } else if (!pipelineMap.has(pipelineId)) {
      // Otherwise, keep the first one we find and check if it matches
      pipelineMap.set(pipelineId, row);
    }
  }

  // Map to ResumablePipeline format
  let pipelines: ResumablePipeline[] = Array.from(pipelineMap.values()).map((row) => ({
    taskId: row.pipeline.taskId,
    pipelineId: row.pipeline.id,
    currentStage: row.stage.stageName as Stage,
    status: row.pipeline.status as 'active' | 'completed' | 'aborted',
    startedAt: new Date(row.pipeline.startedAt),
    updatedAt: row.pipeline.completedAt
      ? new Date(row.pipeline.completedAt)
      : new Date(row.pipeline.startedAt),
    taskTitle: row.task.title,
    stageStatus: row.stage.status as DbStageStatus,
    stageStartedAt: row.stage.startedAt ? new Date(row.stage.startedAt) : undefined,
    blockReason: row.stage.blockReason || undefined,
    resumePriority: calculateResumePriority(row.task.priority, row.stage.status),
  }));

  // Filter by stage if specified
  if (options.stages && options.stages.length > 0) {
    pipelines = pipelines.filter((p) => options.stages!.includes(p.currentStage));
  }

  // Filter by status if needed
  if (!options.includeBlocked) {
    pipelines = pipelines.filter((p) => p.stageStatus !== 'blocked');
  }

  // Filter by minimum priority
  if (options.minPriority) {
    const priorityOrder = { critical: 1, high: 2, medium: 3, low: 4 };
    const minValue = priorityOrder[options.minPriority];
    pipelines = pipelines.filter((p) => {
      const row = results.find((r) => r.pipeline.taskId === p.taskId);
      if (!row) return false;
      const taskPriorityValue = priorityOrder[row.task.priority as keyof typeof priorityOrder] || 4;
      return taskPriorityValue <= minValue;
    });
  }

  // Sort by resume priority
  pipelines.sort((a, b) => a.resumePriority - b.resumePriority);

  // Apply limit
  if (options.limit) {
    pipelines = pipelines.slice(0, options.limit);
  }

  return pipelines;
}

/**
 * Calculate resume priority based on task priority and stage status.
 *
 * @param priority - Task priority
 * @param stageStatus - Current stage status
 * @returns Priority number (lower = higher priority)
 *
 * @task T4805
 */
function calculateResumePriority(
  priority: string | null | undefined,
  stageStatus: string | null | undefined,
): number {
  const priorityOrder = { critical: 1, high: 2, medium: 3, low: 4 };
  const priorityValue = priorityOrder[priority as keyof typeof priorityOrder] || 4;

  // In-progress stages get higher priority (lower number)
  const statusModifier = stageStatus === 'in_progress' ? 0 : stageStatus === 'blocked' ? 10 : 5;

  return priorityValue + statusModifier;
}

/**
 * Load complete pipeline context for session resume.
 *
 * Uses SQL JOINs to efficiently load all related data:
 * - Pipeline and current stage
 * - All stages with their status
 * - Gate results for current stage
 * - Evidence linked to current stage
 * - Recent transitions
 * - Task details
 *
 * @param taskId - The task ID to load context for
 * @param cwd - Working directory for database
 * @returns Promise resolving to pipeline context
 *
 * @example
 * ```typescript
 * const context = await loadPipelineContext('T4805');
 * console.log(`Current stage: ${context.currentStage}`);
 * console.log(`Stage status: ${context.stages.find(s => s.stage === context.currentStage)?.status}`);
 * ```
 *
 * @task T4805
 * @ref T4801 - Uses lifecycle_pipelines, lifecycle_stages, lifecycle_gate_results, lifecycle_evidence tables
 * @ref T4804 - Loads gate results and evidence
 */
export async function loadPipelineContext(
  taskId: string,
  cwd?: string,
): Promise<PipelineContext> {
  const db = await getDb(cwd);

  // Load pipeline with current stage
  const pipelineResult = await db
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
        eq(schema.lifecycleStages.stageName, drizzleSql`${schema.lifecyclePipelines.currentStageId}`),
      ),
    )
    .limit(1)
    .all();

  if (pipelineResult.length === 0) {
    throw new CleoError(
      ExitCode.NOT_FOUND,
      `No active pipeline found for task ${taskId}`,
      {
        fix: 'Check that the task exists and has an active pipeline',
        alternatives: [
          { action: 'List active pipelines', command: 'cleo lifecycle list --status active' },
        ],
      },
    );
  }

  const { pipeline, stage, task } = pipelineResult[0];

  // Load all stages for this pipeline
  const stagesResult = await db
    .select()
    .from(schema.lifecycleStages)
    .where(eq(schema.lifecycleStages.pipelineId, pipeline.id))
    .orderBy(asc(schema.lifecycleStages.sequence))
    .all();

  const stages: StageContext[] = stagesResult.map((s) => ({
    stage: s.stageName as Stage,
    status: s.status as DbStageStatus,
    sequence: s.sequence,
    startedAt: s.startedAt ? new Date(s.startedAt) : undefined,
    completedAt: s.completedAt ? new Date(s.completedAt) : undefined,
    blockedAt: s.blockedAt ? new Date(s.blockedAt) : undefined,
    blockReason: s.blockReason || undefined,
    skippedAt: s.skippedAt ? new Date(s.skippedAt) : undefined,
    skipReason: s.skipReason || undefined,
    notes: s.notesJson ? JSON.parse(s.notesJson) : [],
    metadata: s.metadataJson ? JSON.parse(s.metadataJson) : {},
  }));

  // Load gate results for current stage
  const gateResultsResult = await db
    .select()
    .from(schema.lifecycleGateResults)
    .where(eq(schema.lifecycleGateResults.stageId, stage.id))
    .orderBy(desc(schema.lifecycleGateResults.checkedAt))
    .all();

  const gateResults: GateResultContext[] = gateResultsResult.map((g) => ({
    gateName: g.gateName,
    result: g.result as 'pass' | 'fail' | 'warn',
    checkedAt: new Date(g.checkedAt),
    checkedBy: g.checkedBy,
    details: g.details || undefined,
    reason: g.reason || undefined,
  }));

  // Load evidence for current stage
  const evidenceResult = await db
    .select()
    .from(schema.lifecycleEvidence)
    .where(eq(schema.lifecycleEvidence.stageId, stage.id))
    .orderBy(desc(schema.lifecycleEvidence.recordedAt))
    .all();

  const evidence: EvidenceContext[] = evidenceResult.map((e) => ({
    id: e.id,
    uri: e.uri,
    type: e.type as 'file' | 'url' | 'manifest',
    recordedAt: new Date(e.recordedAt),
    recordedBy: e.recordedBy || undefined,
    description: e.description || undefined,
  }));

  // Load recent transitions
  const transitionsResult = await db
    .select()
    .from(schema.lifecycleTransitions)
    .where(eq(schema.lifecycleTransitions.pipelineId, pipeline.id))
    .orderBy(desc(schema.lifecycleTransitions.createdAt))
    .limit(10)
    .all();

  const recentTransitions: TransitionContext[] = transitionsResult.map((t) => ({
    fromStage: t.fromStageId,
    toStage: t.toStageId,
    transitionedAt: new Date(t.createdAt),
    transitionedBy: 'system', // TODO: Store agent in transitions table
    reason: undefined,
  }));

  return {
    taskId,
    pipelineId: pipeline.id,
    currentStage: stage.stageName as Stage,
    stages,
    gateResults,
    evidence,
    recentTransitions,
    task: {
      id: task.id,
      title: task.title,
      description: task.description || undefined,
      status: task.status,
      priority: task.priority,
      parentId: task.parentId || undefined,
    },
  };
}

/**
 * Resume a specific stage in a pipeline.
 *
 * Updates the stage status from 'blocked' or 'not_started' to 'in_progress',
 * records the transition, and returns the resume result.
 *
 * @param taskId - The task ID
 * @param targetStage - The stage to resume
 * @param options - Resume options
 * @param cwd - Working directory for database
 * @returns Promise resolving to resume result
 *
 * @example
 * ```typescript
 * const result = await resumeStage('T4805', 'implement');
 * if (result.success) {
 *   console.log(`Resumed ${result.taskId} at ${result.stage}`);
 * }
 * ```
 *
 * @task T4805
 * @ref T4801 - Updates lifecycle_stages table
 * @ref T4800 - Integrates with pipeline state machine
 */
export async function resumeStage(
  taskId: string,
  targetStage: Stage,
  options: {
    reason?: string;
    agent?: string;
    force?: boolean;
  } = {},
  cwd?: string,
): Promise<ResumeResult> {
  const validatedStage = validateStage(targetStage);
  const db = await getDb(cwd);

  // Find the pipeline and stage
  const pipelineResult = await db
    .select({
      pipeline: schema.lifecyclePipelines,
      stageRecord: schema.lifecycleStages,
    })
    .from(schema.lifecyclePipelines)
    .innerJoin(
      schema.lifecycleStages,
      and(
        eq(schema.lifecycleStages.pipelineId, schema.lifecyclePipelines.id),
        eq(schema.lifecycleStages.stageName, validatedStage),
      ),
    )
    .where(eq(schema.lifecyclePipelines.taskId, taskId))
    .limit(1)
    .all();

  if (pipelineResult.length === 0) {
    throw new CleoError(
      ExitCode.NOT_FOUND,
      `No pipeline found for task ${taskId} with stage ${validatedStage}`,
    );
  }

  const { pipeline, stageRecord } = pipelineResult[0];

  // Check if resume is possible
  const previousStatus = stageRecord.status as DbStageStatus;
  const warnings: string[] = [];

  if (previousStatus === 'completed') {
    if (!options.force) {
      throw new CleoError(
        ExitCode.LIFECYCLE_TRANSITION_INVALID,
        `Stage ${validatedStage} is already completed. Use force=true to resume completed stages.`,
      );
    }
    warnings.push(`Resuming already-completed stage ${validatedStage}`);
  }

  if (previousStatus === 'in_progress') {
    return {
      success: true,
      taskId,
      stage: validatedStage,
      previousStatus,
      newStatus: 'in_progress',
      resumedAt: new Date(),
      message: `Stage ${validatedStage} is already in progress`,
      warnings: [],
    };
  }

  const now = new Date();

  // Update stage status to in_progress
  await db
    .update(schema.lifecycleStages)
    .set({
      status: 'in_progress',
      startedAt: now.toISOString(),
      blockedAt: null,
      blockReason: null,
    })
    .where(eq(schema.lifecycleStages.id, stageRecord.id))
    .run();

  // Record the resume transition
  const previousStage = pipeline.currentStageId;
  if (previousStage && previousStage !== validatedStage) {
    await db
      .insert(schema.lifecycleTransitions)
      .values({
        id: `transition-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        pipelineId: pipeline.id,
        fromStageId: previousStage,
        toStageId: stageRecord.id,
        transitionType: 'manual',
        createdAt: now.toISOString(),
      })
      .run();
  }

  // Update pipeline current stage if different
  if (pipeline.currentStageId !== validatedStage) {
    await db
      .update(schema.lifecyclePipelines)
      .set({
        currentStageId: validatedStage,
      })
      .where(eq(schema.lifecyclePipelines.id, pipeline.id))
      .run();
  }

  return {
    success: true,
    taskId,
    stage: validatedStage,
    previousStatus,
    newStatus: 'in_progress',
    resumedAt: now,
    message: `Resumed ${taskId} at stage ${validatedStage}`,
    warnings,
  };
}

/**
 * Auto-detect where to resume across all active pipelines.
 *
 * Finds the best candidate for resuming work based on:
 * 1. Active stages (currently in progress)
 * 2. Blocked stages (can be unblocked)
 * 3. Failed stages (can be retried)
 * 4. Priority ordering
 *
 * @param cwd - Working directory for database
 * @returns Promise resolving to auto-resume result
 *
 * @example
 * ```typescript
 * const result = await autoResume();
 * if (result.canResume) {
 *   console.log(`Recommended: Resume ${result.taskId} at ${result.stage}`);
 * } else if (result.options && result.options.length > 0) {
 *   console.log('Multiple options available:', result.options);
 * }
 * ```
 *
 * @task T4805
 * @ref T4801 - Queries lifecycle_pipelines, lifecycle_stages tables
 * @ref T4798 - Implements RCASD-IVTR+C resume logic
 */
export async function autoResume(cwd?: string): Promise<AutoResumeResult> {
  const db = await getDb(cwd);

  // Find all active pipelines with their current stages
  const activePipelines = await db
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
    .where(eq(schema.lifecyclePipelines.status, 'active'))
    .orderBy(asc(schema.tasks.priority), desc(schema.lifecycleStages.startedAt))
    .all();

  if (activePipelines.length === 0) {
    return {
      canResume: false,
      recommendation: 'none',
      message: 'No active pipelines found for resume',
    };
  }

  // Score and rank resume candidates
  interface Candidate {
    taskId: string;
    stage: Stage;
    stageStatus: DbStageStatus;
    pipelineId: string;
    score: number;
    reason: string;
  }

  const candidates: Candidate[] = activePipelines.map((row) => {
    const stageStatus = row.stage.status as DbStageStatus;
    const priority = row.task.priority;
    let score = 0;
    let reason = '';

    // Score based on stage status
    switch (stageStatus) {
      case 'in_progress':
        score = 100;
        reason = 'Stage already in progress';
        break;
      case 'blocked':
        score = 70;
        reason = 'Blocked stage can be unblocked';
        break;
      case 'not_started':
        score = 40;
        reason = 'Pending stage ready to start';
        break;
      case 'completed':
      case 'skipped':
        // These are lower priority - pipeline might need to advance
        score = 20;
        reason = 'Stage completed, may need to advance';
        break;
      default:
        score = 30;
        reason = 'Unknown stage status';
    }

    // Adjust score based on priority
    const priorityMultiplier = { critical: 2.0, high: 1.5, medium: 1.0, low: 0.8 };
    score *= priorityMultiplier[priority as keyof typeof priorityMultiplier] || 1.0;

    // Boost score for recently started stages
    if (row.stage.startedAt) {
      const hoursSinceStart = (Date.now() - new Date(row.stage.startedAt).getTime()) / (1000 * 60 * 60);
      if (hoursSinceStart < 24) {
        score *= 1.2; // Boost recent work
      }
    }

    return {
      taskId: row.pipeline.taskId,
      stage: row.stage.stageName as Stage,
      stageStatus,
      pipelineId: row.pipeline.id,
      score,
      reason,
    };
  });

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);

  // Get top candidates
  const topCandidate = candidates[0];
  const highScoreCandidates = candidates.filter((c) => c.score >= 80);

  if (highScoreCandidates.length === 1) {
    // Clear winner - load context and recommend
    const context = await loadPipelineContext(topCandidate.taskId, cwd);
    return {
      canResume: true,
      taskId: topCandidate.taskId,
      stage: topCandidate.stage,
      context,
      recommendation: 'resume',
      message: `Resume ${topCandidate.taskId} at ${topCandidate.stage}: ${topCandidate.reason}`,
    };
  }

  if (highScoreCandidates.length > 1) {
    // Multiple good options - present choices
    const options = await findResumablePipelines(
      {
        taskIds: highScoreCandidates.map((c) => c.taskId),
        limit: 5,
      },
      cwd,
    );

    return {
      canResume: true,
      recommendation: 'choose',
      message: `Found ${highScoreCandidates.length} resumable pipelines. Please choose one.`,
      options,
    };
  }

  // No high-scoring candidates but some pipelines exist
  if (candidates.length > 0) {
    // Check if we should advance any pipelines
    const completedStages = candidates.filter((c) => c.stageStatus === 'completed' || c.stageStatus === 'skipped');

    if (completedStages.length > 0) {
      // These pipelines may need to advance to next stage
      return {
        canResume: false,
        recommendation: 'none',
        message: `Found ${completedStages.length} pipelines that may need to advance to next stage`,
      };
    }

    // Return all options for user to choose
    const options = await findResumablePipelines({ limit: 5 }, cwd);
    return {
      canResume: true,
      recommendation: 'choose',
      message: `Found ${candidates.length} potential resume points. Please review options.`,
      options,
    };
  }

  return {
    canResume: false,
    recommendation: 'none',
    message: 'No suitable resume points found',
  };
}

// =============================================================================
// SESSION INTEGRATION
// =============================================================================

/**
 * Options for session start with resume check.
 *
 * @task T4805
 */
export interface SessionResumeCheckOptions {
  /** Whether to auto-resume if only one candidate */
  autoResume?: boolean;

  /** Scope to filter resumable pipelines */
  scope?: {
    type: 'epic' | 'global';
    epicId?: string;
  };

  /** Minimum priority to consider */
  minPriority?: 'critical' | 'high' | 'medium' | 'low';

  /** Whether to include blocked pipelines */
  includeBlocked?: boolean;
}

/**
 * Result of session resume check.
 *
 * @task T4805
 */
export interface SessionResumeCheckResult {
  /** Whether resume was performed */
  didResume: boolean;

  /** Resumed task ID if auto-resumed */
  resumedTaskId?: string;

  /** Resumed stage if auto-resumed */
  resumedStage?: Stage;

  /** Available resume options if not auto-resumed */
  options?: ResumablePipeline[];

  /** Message for user */
  message: string;

  /** Whether user action is required */
  requiresUserChoice: boolean;
}

/**
 * Check for resumable work on session start.
 *
 * Integrates with session initialization to check for active pipelines
 * and present resumable work to the user. Can auto-resume if there's
 * a clear single candidate.
 *
 * @param options - Resume check options
 * @param cwd - Working directory for database
 * @returns Promise resolving to resume check result
 *
 * @example
 * ```typescript
 * // On session start
 * const resumeCheck = await checkSessionResume({ autoResume: true });
 * if (resumeCheck.didResume) {
 *   console.log(`Auto-resumed ${resumeCheck.resumedTaskId}`);
 * } else if (resumeCheck.requiresUserChoice) {
 *   console.log('Multiple options:', resumeCheck.options);
 * }
 * ```
 *
 * @task T4805
 * @integration Session Start Hook
 */
export async function checkSessionResume(
  options: SessionResumeCheckOptions = {},
  cwd?: string,
): Promise<SessionResumeCheckResult> {
  // Find resumable pipelines
  const findOptions: FindResumableOptions = {
    includeBlocked: options.includeBlocked ?? true,
    minPriority: options.minPriority,
    limit: 10,
  };

  const resumable = await findResumablePipelines(findOptions, cwd);

  if (resumable.length === 0) {
    return {
      didResume: false,
      message: 'No resumable pipelines found. Starting fresh session.',
      requiresUserChoice: false,
    };
  }

  // Filter by scope if provided
  let filtered = resumable;
  if (options.scope?.type === 'epic' && options.scope.epicId) {
    // For epic scope, we'd need to check task parent hierarchy
    // This is a simplified version
    filtered = resumable.filter((r) => r.taskId === options.scope!.epicId || r.taskId.startsWith(options.scope!.epicId!));
  }

  if (filtered.length === 0) {
    return {
      didResume: false,
      message: `No resumable pipelines in scope ${options.scope?.type === 'epic' ? options.scope.epicId : 'global'}.`,
      requiresUserChoice: false,
    };
  }

  // If only one candidate and autoResume enabled, resume it
  if (filtered.length === 1 && options.autoResume) {
    const candidate = filtered[0];

    // Only auto-resume if stage is in_progress, blocked, or not_started
    if (['in_progress', 'blocked', 'not_started'].includes(candidate.stageStatus)) {
      try {
        await resumeStage(
          candidate.taskId,
          candidate.currentStage,
          { reason: 'Auto-resumed on session start' },
          cwd,
        );

        return {
          didResume: true,
          resumedTaskId: candidate.taskId,
          resumedStage: candidate.currentStage,
          message: `Auto-resumed ${candidate.taskId} at ${candidate.currentStage} stage`,
          requiresUserChoice: false,
        };
      } catch (error) {
        // Auto-resume failed, present options
        return {
          didResume: false,
          options: filtered,
          message: `Found ${filtered.length} resumable pipeline(s). Auto-resume failed, please choose.`,
          requiresUserChoice: true,
        };
      }
    }
  }

  // Multiple candidates or auto-resume disabled - present options
  return {
    didResume: false,
    options: filtered,
    message:
      filtered.length === 1
        ? `Found 1 resumable pipeline: ${filtered[0].taskTitle} (${filtered[0].taskId})`
        : `Found ${filtered.length} resumable pipelines. Please choose one to resume.`,
    requiresUserChoice: true,
  };
}

/**
 * Get resume summary for display to user.
 *
 * Formats resumable pipelines into a human-readable summary.
 *
 * @param pipelines - Resumable pipelines
 * @returns Formatted summary string
 *
 * @task T4805
 */
export function formatResumeSummary(pipelines: ResumablePipeline[]): string {
  if (pipelines.length === 0) {
    return 'No resumable pipelines found.';
  }

  const lines: string[] = [`Found ${pipelines.length} resumable pipeline(s):`, ''];

  pipelines.forEach((p, index) => {
    const statusIcon = STAGE_STATUS_ICONS[p.stageStatus] ?? STAGE_STATUS_ICONS.not_started;
    const priorityIcon = p.taskTitle.toLowerCase().includes('critical')
      ? '🔴'
      : p.taskTitle.toLowerCase().includes('high')
        ? '🟠'
        : '🟡';

    lines.push(`${index + 1}. ${statusIcon} ${priorityIcon} ${p.taskTitle}`);
    lines.push(`   Task: ${p.taskId} | Stage: ${p.currentStage} (${p.stageStatus})`);

    if (p.blockReason) {
      lines.push(`   Blocked: ${p.blockReason}`);
    }

    if (p.stageStartedAt) {
      const hoursAgo = Math.floor((Date.now() - p.stageStartedAt.getTime()) / (1000 * 60 * 60));
      lines.push(`   Started: ${hoursAgo}h ago`);
    }

    lines.push('');
  });

  lines.push('Use `cleo lifecycle resume <taskId>` to resume a specific pipeline.');

  return lines.join('\n');
}

// =============================================================================
// EDGE CASE HANDLING
// =============================================================================

/**
 * Handle completed stage edge case.
 *
 * If the current stage is completed, suggests advancing to next stage.
 *
 * @param context - Pipeline context
 * @returns Recommendation for handling completed stage
 *
 * @task T4805
 */
export function handleCompletedStage(context: PipelineContext): {
  action: 'advance' | 'stay' | 'review';
  message: string;
  nextStage?: Stage;
} {
  const currentStageContext = context.stages.find((s) => s.stage === context.currentStage);

  if (!currentStageContext || currentStageContext.status !== 'completed') {
    return {
      action: 'stay',
      message: `Stage ${context.currentStage} is not completed`,
    };
  }

  const nextStage = getNextStage(context.currentStage);

  if (!nextStage) {
    return {
      action: 'review',
      message: `All stages completed for ${context.taskId}. Pipeline is ready for completion.`,
    };
  }

  return {
    action: 'advance',
    message: `Stage ${context.currentStage} is completed. Ready to advance to ${nextStage}.`,
    nextStage,
  };
}

/**
 * Handle blocked stage edge case.
 *
 * Provides information about why a stage is blocked and potential resolutions.
 *
 * @param context - Pipeline context
 * @returns Block analysis and resolution hints
 *
 * @task T4805
 */
export function handleBlockedStage(context: PipelineContext): {
  isBlocked: boolean;
  blockReason?: string;
  blockedSince?: Date;
  resolutions: string[];
  canUnblock: boolean;
} {
  const currentStageContext = context.stages.find((s) => s.stage === context.currentStage);

  if (!currentStageContext || currentStageContext.status !== 'blocked') {
    return {
      isBlocked: false,
      canUnblock: false,
      resolutions: [],
    };
  }

  const resolutions: string[] = [];

  // Check gate results for failures
  const failedGates = context.gateResults.filter((g) => g.result === 'fail');
  if (failedGates.length > 0) {
    resolutions.push(`Address failed gate(s): ${failedGates.map((g) => g.gateName).join(', ')}`);
  }

  // Check for missing evidence
  if (context.evidence.length === 0) {
    resolutions.push('Add required evidence to complete stage');
  }

  // Check prerequisite stages
  const prerequisiteStages = context.stages.filter(
    (s) => s.sequence < currentStageContext.sequence && s.status !== 'completed' && s.status !== 'skipped',
  );
  if (prerequisiteStages.length > 0) {
    resolutions.push(`Complete prerequisite stage(s): ${prerequisiteStages.map((s) => s.stage).join(', ')}`);
  }

  // Generic resolution
  if (resolutions.length === 0) {
    resolutions.push('Review block reason and address underlying issue');
    resolutions.push('Use force flag to override block if appropriate');
  }

  return {
    isBlocked: true,
    blockReason: currentStageContext.blockReason,
    blockedSince: currentStageContext.blockedAt,
    resolutions,
    canUnblock: resolutions.length > 0,
  };
}

/**
 * Handle blocked stage edge case - async version with database lookup.
 *
 * @param taskId - Task ID to check
 * @param cwd - Working directory
 * @returns Block analysis with prerequisite details
 *
 * @task T4805
 */
export async function checkBlockedStageDetails(
  taskId: string,
  cwd?: string,
): Promise<{
  isBlocked: boolean;
  blockReason?: string;
  blockedSince?: Date;
  resolutions: string[];
  canUnblock: boolean;
  prerequisites?: { stage: Stage; status: DbStageStatus; completed: boolean }[];
}> {
  const db = await getDb(cwd);

  // Find pipeline and current stage
  const pipelineResult = await db
    .select({
      pipeline: schema.lifecyclePipelines,
      stage: schema.lifecycleStages,
    })
    .from(schema.lifecyclePipelines)
    .innerJoin(
      schema.lifecycleStages,
      eq(schema.lifecycleStages.pipelineId, schema.lifecyclePipelines.id),
    )
    .where(
      and(
        eq(schema.lifecyclePipelines.taskId, taskId),
        eq(schema.lifecycleStages.stageName, drizzleSql`${schema.lifecyclePipelines.currentStageId}`),
      ),
    )
    .limit(1)
    .all();

  if (pipelineResult.length === 0) {
    return {
      isBlocked: false,
      canUnblock: false,
      resolutions: ['No pipeline found for task'],
    };
  }

  const { pipeline, stage } = pipelineResult[0];
  const stageStatus = stage.status as DbStageStatus;

  if (stageStatus !== 'blocked') {
    return {
      isBlocked: false,
      canUnblock: false,
      resolutions: [],
    };
  }

  // Get all stages to check prerequisites
  const allStages = await db
    .select()
    .from(schema.lifecycleStages)
    .where(eq(schema.lifecycleStages.pipelineId, pipeline.id))
    .orderBy(asc(schema.lifecycleStages.sequence))
    .all();

  const currentSequence = stage.sequence;
  const prerequisites = allStages
    .filter((s) => s.sequence < currentSequence)
    .map((s) => ({
      stage: s.stageName as Stage,
      status: s.status as DbStageStatus,
      completed: s.status === 'completed' || s.status === 'skipped',
    }));

  const incompletePrereqs = prerequisites.filter((p) => !p.completed);

  const resolutions: string[] = [];

  if (stage.blockReason) {
    resolutions.push(`Address block reason: ${stage.blockReason}`);
  }

  if (incompletePrereqs.length > 0) {
    resolutions.push(
      `Complete prerequisite stage(s): ${incompletePrereqs.map((p) => p.stage).join(', ')}`,
    );
  }

  // Check for failed gates
  const gateResults = await db
    .select()
    .from(schema.lifecycleGateResults)
    .where(eq(schema.lifecycleGateResults.stageId, stage.id))
    .all();

  const failedGates = gateResults.filter((g) => g.result === 'fail');
  if (failedGates.length > 0) {
    resolutions.push(`Fix failed gate(s): ${failedGates.map((g) => g.gateName).join(', ')}`);
  }

  if (resolutions.length === 0) {
    resolutions.push('Review pipeline state and address block conditions');
  }

  return {
    isBlocked: true,
    blockReason: stage.blockReason || undefined,
    blockedSince: stage.blockedAt ? new Date(stage.blockedAt) : undefined,
    resolutions,
    canUnblock: resolutions.length > 0,
    prerequisites,
  };
}
