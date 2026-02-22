/**
 * Pipeline State Machine - Core Logic
 * 
 * Implements the finite state machine for pipeline lifecycle management.
 * Handles state transitions, prerequisite validation, and transition history.
 * 
 * State Machine States:
 *   not_started → in_progress → completed
 *                        ↓
 *                   blocked/failed
 *                        ↓
 *                    skipped
 * 
 * @task T4800 - Implement Canonical SQLite Pipeline State Machine
 * @epic T4798 - Lifecycle persistence improvements
 * @audit T4799 - Unified state machine replaces scattered logic
 * @depends T4801 - Schema design
 * @depends stages.ts - Stage definitions and transition rules
 */

import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import type { Stage, StageStatus } from './stages.js';
import {
  getPrerequisites,
  checkTransition,
  STAGE_DEFINITIONS,
  PIPELINE_STAGES,
} from './stages.js';
// TODO(T4801): Import once schema is ready
// import { getDb } from '../../store/sqlite.js';
// import * as schema from '../../store/schema.js';
// import { eq, and } from 'drizzle-orm';

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/**
 * Prerequisite check result.
 * 
 * @task T4800
 */
export interface PrereqCheck {
  /** Whether all prerequisites are met */
  met: boolean;
  
  /** List of prerequisite stages */
  prerequisites: Stage[];
  
  /** Stages that are completed or skipped */
  completed: Stage[];
  
  /** Stages that are pending or blocked */
  pending: Stage[];
  
  /** Stages that failed */
  failed: Stage[];
  
  /** Blocking issues preventing progression */
  blockers: Array<{
    stage: Stage;
    reason: string;
    severity: 'error' | 'warning' | 'info';
  }>;
  
  /** Whether the check can be overridden with force */
  canForce: boolean;
  
  /** Human-readable summary */
  summary: string;
}

/**
 * Transition validation result.
 * 
 * @task T4800
 */
export interface TransitionValidation {
  /** Whether the transition is valid */
  valid: boolean;
  
  /** Source stage */
  from: Stage;
  
  /** Target stage */
  to: Stage;
  
  /** Whether prerequisites are met */
  prerequisitesMet: boolean;
  
  /** Whether the transition rule allows it */
  ruleAllowed: boolean;
  
  /** Whether force is required */
  requiresForce: boolean;
  
  /** List of validation errors */
  errors: string[];
  
  /** List of warnings */
  warnings: string[];
  
  /** Prerequisite check details */
  prereqCheck?: PrereqCheck;
}

/**
 * Stage state snapshot for state machine.
 * 
 * @task T4800
 */
export interface StageState {
  stage: Stage;
  status: StageStatus;
  startedAt?: Date;
  completedAt?: Date;
  assignedAgent?: string;
  notes?: string;
}

/**
 * State machine context for a pipeline.
 * 
 * @task T4800
 */
export interface StateMachineContext {
  pipelineId: string;
  currentStage: Stage;
  stages: Record<Stage, StageState>;
  transitionCount: number;
  version: number;
}

/**
 * State transition request.
 * 
 * @task T4800
 */
export interface StateTransition {
  from: Stage;
  to: Stage;
  reason?: string;
  initiatedBy: string;
  force?: boolean;
  skipValidation?: boolean;
}

/**
 * State transition result.
 * 
 * @task T4800
 */
export interface StateTransitionResult {
  success: boolean;
  transition: StateTransition;
  previousState: StageState;
  newState: StageState;
  context: StateMachineContext;
  timestamp: Date;
  errors?: string[];
}

// =============================================================================
// PREREQUISITE CHECKING
// =============================================================================

/**
 * Check if prerequisites are met for a stage.
 * 
 * Validates that all prerequisite stages are in an acceptable state
 * (completed or skipped) for the target stage to proceed.
 * 
 * @param targetStage - The stage to check prerequisites for
 * @param currentStages - Current state of all stages
 * @throws {CleoError} If validation fails
 * @returns Promise resolving to PrereqCheck result
 * 
 * @example
 * ```typescript
 * const check = await checkPrerequisites('implement', {
 *   research: { status: 'completed' },
 *   spec: { status: 'completed' },
 *   decompose: { status: 'completed' },
 *   // ... other stages
 * });
 * if (check.met) {
 *   console.log('Ready to implement');
 * }
 * ```
 * 
 * @task T4800
 * @depends T4801 - Requires pipeline_stages table
 */
export async function checkPrerequisites(
  targetStage: Stage,
  currentStages: Record<Stage, StageState>
): Promise<PrereqCheck> {
  // STUB: Implementation pending T4801 schema completion
  //
  // TODO(T4801): Full implementation will query from database:
  // 1. Query pipeline_stages for all stages of the pipeline
  // 2. Check each prerequisite status
  // 3. Return comprehensive PrereqCheck result
  //
  // Current behavior: Calculate from provided currentStages
  const prerequisites = getPrerequisites(targetStage);
  
  const completed: Stage[] = [];
  const pending: Stage[] = [];
  const failed: Stage[] = [];
  const blockers: PrereqCheck['blockers'] = [];
  
  for (const prereq of prerequisites) {
    const stageState = currentStages[prereq];
    
    if (!stageState) {
      pending.push(prereq);
      blockers.push({
        stage: prereq,
        reason: 'Stage not initialized',
        severity: 'error',
      });
      continue;
    }
    
    switch (stageState.status) {
      case 'completed':
      case 'skipped':
        completed.push(prereq);
        break;
      case 'in_progress':
        pending.push(prereq);
        blockers.push({
          stage: prereq,
          reason: 'Stage still in progress',
          severity: 'error',
        });
        break;
      case 'not_started':
        pending.push(prereq);
        blockers.push({
          stage: prereq,
          reason: 'Stage not started',
          severity: 'error',
        });
        break;
      case 'blocked':
        pending.push(prereq);
        blockers.push({
          stage: prereq,
          reason: 'Stage is blocked',
          severity: 'error',
        });
        break;
      case 'failed':
        failed.push(prereq);
        blockers.push({
          stage: prereq,
          reason: 'Stage failed',
          severity: 'error',
        });
        break;
    }
  }
  
  const met = blockers.filter(b => b.severity === 'error').length === 0;
  const canForce = blockers.every(b => b.severity !== 'error' || b.reason !== 'Stage not initialized');
  
  let summary: string;
  if (met) {
    summary = `All ${prerequisites.length} prerequisites met for ${targetStage}`;
  } else {
    const errorCount = blockers.filter(b => b.severity === 'error').length;
    summary = `${errorCount} prerequisite(s) blocking ${targetStage}`;
  }
  
  return {
    met,
    prerequisites,
    completed,
    pending,
    failed,
    blockers,
    canForce,
    summary,
  };
}

/**
 * Validate a stage transition.
 * 
 * Comprehensive validation that checks both transition rules and prerequisites.
 * This is the core state machine validation logic.
 * 
 * @param transition - The transition to validate
 * @param context - Current state machine context
 * @throws {CleoError} If validation fails unexpectedly
 * @returns Promise resolving to TransitionValidation
 * 
 * @example
 * ```typescript
 * const validation = await validateTransition(
 *   { from: 'spec', to: 'implement', initiatedBy: 'agent-001' },
 *   pipelineContext
 * );
 * if (!validation.valid) {
 *   console.log(validation.errors);
 * }
 * ```
 * 
 * @task T4800
 */
export async function validateTransition(
  transition: StateTransition,
  context: StateMachineContext
): Promise<TransitionValidation> {
  const { from, to, force } = transition;
  const errors: string[] = [];
  const warnings: string[] = [];
  
  // Check transition rules
  const ruleCheck = checkTransition(from, to, force);
  
  if (!ruleCheck.allowed && !ruleCheck.requiresForce) {
    errors.push(ruleCheck.reason || `Transition from ${from} to ${to} is not allowed`);
  }
  
  if (ruleCheck.requiresForce && !force) {
    errors.push(ruleCheck.reason || `Transition from ${from} to ${to} requires force flag`);
  }
  
  // Check prerequisites for target stage
  let prereqCheck: PrereqCheck | undefined;
  
  if (!transition.skipValidation) {
    prereqCheck = await checkPrerequisites(to, context.stages);
    
    if (!prereqCheck.met) {
      if (!force) {
        for (const blocker of prereqCheck.blockers) {
          errors.push(`${blocker.stage}: ${blocker.reason}`);
        }
      } else {
        warnings.push('Prerequisites not met but force flag is set');
        for (const blocker of prereqCheck.blockers) {
          warnings.push(`${blocker.stage}: ${blocker.reason}`);
        }
      }
    }
  }
  
  // Validate current stage matches context
  if (context.currentStage !== from) {
    errors.push(
      `Current stage mismatch: context has ${context.currentStage}, ` +
      `but transition is from ${from}`
    );
  }
  
  // Check stage status allows transition
  const fromState = context.stages[from];
  if (!fromState) {
    errors.push(`Source stage ${from} not found in context`);
  } else if (fromState.status === 'not_started') {
    errors.push(`Cannot transition from ${from}: stage has not started`);
  } else if (fromState.status === 'completed') {
    warnings.push(`Source stage ${from} is already completed`);
  }
  
  const valid = errors.length === 0;
  
  return {
    valid,
    from,
    to,
    prerequisitesMet: prereqCheck?.met ?? true,
    ruleAllowed: ruleCheck.allowed || (ruleCheck.requiresForce && !!force),
    requiresForce: ruleCheck.requiresForce,
    errors,
    warnings,
    prereqCheck,
  };
}

// =============================================================================
// STATE TRANSITION EXECUTION
// =============================================================================

/**
 * Execute a state transition.
 * 
 * Applies the transition to the state machine context, updating stage statuses
 * and returning the new state. This function does NOT persist to database -
 * that is handled by the pipeline module.
 * 
 * @param transition - The transition to execute
 * @param context - Current state machine context
 * @throws {CleoError} If transition is invalid
 * @returns Promise resolving to StateTransitionResult
 * 
 * @example
 * ```typescript
 * const result = await executeTransition(
 *   { from: 'spec', to: 'implement', initiatedBy: 'agent-001' },
 *   pipelineContext
 * );
 * if (result.success) {
 *   console.log(`Transitioned to ${result.newState.stage}`);
 * }
 * ```
 * 
 * @task T4800
 */
export async function executeTransition(
  transition: StateTransition,
  context: StateMachineContext
): Promise<StateTransitionResult> {
  // Validate first
  const validation = await validateTransition(transition, context);
  
  if (!validation.valid) {
    return {
      success: false,
      transition,
      previousState: context.stages[transition.from],
      newState: context.stages[transition.from], // No change
      context,
      timestamp: new Date(),
      errors: validation.errors,
    };
  }
  
  const now = new Date();
  const { from, to } = transition;
  
  // Create new context (immutable update)
  const newContext: StateMachineContext = {
    ...context,
    currentStage: to,
    transitionCount: context.transitionCount + 1,
    version: context.version + 1,
    stages: { ...context.stages },
  };
  
  // Update from stage
  newContext.stages[from] = {
    ...context.stages[from],
    status: 'completed',
    completedAt: now,
  };
  
  // Update to stage
  const toStageCurrent = context.stages[to];
  newContext.stages[to] = {
    ...toStageCurrent,
    stage: to,
    status: 'in_progress',
    startedAt: toStageCurrent?.startedAt || now,
  };
  
  return {
    success: true,
    transition,
    previousState: context.stages[from],
    newState: newContext.stages[to],
    context: newContext,
    timestamp: now,
  };
}

// =============================================================================
// STAGE STATUS MANAGEMENT
// =============================================================================

/**
 * Set the status of a stage.
 * 
 * Updates stage status with validation of allowed state transitions.
 * 
 * @param stage - The stage to update
 * @param status - The new status
 * @param context - Current state machine context
 * @throws {CleoError} If status transition is invalid
 * @returns Updated StageState
 * 
 * @task T4800
 */
export function setStageStatus(
  stage: Stage,
  status: StageStatus,
  context: StateMachineContext
): StageState {
  const currentState = context.stages[stage];
  
  if (!currentState) {
    throw new CleoError(
      ExitCode.NOT_FOUND,
      `Stage ${stage} not found in context`
    );
  }
  
  // Validate status transition
  const validTransition = isValidStatusTransition(currentState.status, status);
  if (!validTransition.valid) {
    throw new CleoError(
      ExitCode.LIFECYCLE_TRANSITION_INVALID,
      `Invalid status transition from ${currentState.status} to ${status}: ${validTransition.reason}`
    );
  }
  
  const now = new Date();
  const updatedState: StageState = {
    ...currentState,
    status,
  };
  
  // Set timestamps based on status
  if (status === 'in_progress' && !currentState.startedAt) {
    updatedState.startedAt = now;
  }
  
  if (status === 'completed' || status === 'skipped') {
    updatedState.completedAt = now;
  }
  
  return updatedState;
}

/**
 * Get the status of a stage.
 * 
 * @param stage - The stage to check
 * @param context - Current state machine context
 * @returns The stage status
 * 
 * @task T4800
 */
export function getStageStatus(
  stage: Stage,
  context: StateMachineContext
): StageStatus {
  return context.stages[stage]?.status ?? 'not_started';
}

/**
 * Check if a status transition is valid.
 * 
 * State transitions:
 *   not_started → in_progress, skipped
 *   in_progress → completed, blocked, failed
 *   blocked     → in_progress
 *   failed      → in_progress (retry)
 *   completed   → (no transition - use force to override)
 *   skipped     → (no transition)
 * 
 * @param from - Current status
 * @param to - Target status
 * @returns Object with valid flag and reason
 * 
 * @task T4800
 */
export function isValidStatusTransition(
  from: StageStatus,
  to: StageStatus
): { valid: boolean; reason?: string } {
  // Same status - always valid (idempotent)
  if (from === to) {
    return { valid: true };
  }
  
  const validTransitions: Record<StageStatus, StageStatus[]> = {
    not_started: ['in_progress', 'skipped'],
    in_progress: ['completed', 'blocked', 'failed', 'not_started'],
    blocked: ['in_progress', 'failed'],
    failed: ['in_progress', 'not_started'],
    completed: [],
    skipped: [],
  };
  
  const allowed = validTransitions[from]?.includes(to);
  
  if (!allowed) {
    return {
      valid: false,
      reason: `Cannot transition from ${from} to ${to}. ` +
        `Allowed: ${validTransitions[from]?.join(', ') || 'none'}`,
    };
  }
  
  return { valid: true };
}

// =============================================================================
// STATE MACHINE CONTEXT OPERATIONS
// =============================================================================

/**
 * Create initial state machine context for a pipeline.
 * 
 * @param pipelineId - The pipeline/task ID
 * @param assignedAgent - Optional agent to assign
 * @returns Initial StateMachineContext
 * 
 * @task T4800
 */
export function createInitialContext(
  pipelineId: string,
  assignedAgent?: string
): StateMachineContext {
  const now = new Date();
  const stages: Record<Stage, StageState> = {} as Record<Stage, StageState>;
  
  for (const stage of PIPELINE_STAGES) {
    stages[stage] = {
      stage,
      status: stage === 'research' ? 'in_progress' : 'not_started',
      assignedAgent,
    };
  }
  
  // Set research started timestamp
  stages['research'].startedAt = now;
  
  return {
    pipelineId,
    currentStage: 'research',
    stages,
    transitionCount: 0,
    version: 1,
  };
}

/**
 * Get stages that can be transitioned to from the current stage.
 * 
 * @param context - Current state machine context
 * @param includeForce - Whether to include transitions that require force
 * @returns Array of valid next stages
 * 
 * @task T4800
 */
export function getValidNextStages(
  context: StateMachineContext,
  includeForce: boolean = false
): Stage[] {
  return PIPELINE_STAGES.filter((stage) => {
    if (stage === context.currentStage) return false;
    
    const checkResult = checkTransition(context.currentStage, stage, includeForce);
    return checkResult.allowed || (includeForce && checkResult.requiresForce);
  });
}

/**
 * Get the current stage state.
 * 
 * @param context - State machine context
 * @returns Current StageState
 * 
 * @task T4800
 */
export function getCurrentStageState(
  context: StateMachineContext
): StageState {
  return context.stages[context.currentStage];
}

/**
 * Check if the pipeline is in a terminal state.
 * 
 * @param context - State machine context
 * @returns True if in release stage and completed
 * 
 * @task T4800
 */
export function isTerminalState(context: StateMachineContext): boolean {
  return context.currentStage === 'release' && 
         context.stages['release'].status === 'completed';
}

/**
 * Check if the pipeline is blocked.
 * 
 * @param context - State machine context
 * @returns True if current stage is blocked
 * 
 * @task T4800
 */
export function isBlocked(context: StateMachineContext): boolean {
  return context.stages[context.currentStage].status === 'blocked';
}

// =============================================================================
// BATCH OPERATIONS
// =============================================================================

/**
 * Validate multiple transitions.
 * 
 * @param transitions - Array of transitions to validate
 * @param context - State machine context
 * @returns Array of validation results
 * 
 * @task T4800
 */
export async function validateTransitions(
  transitions: StateTransition[],
  context: StateMachineContext
): Promise<TransitionValidation[]> {
  return Promise.all(
    transitions.map(t => validateTransition(t, context))
  );
}

/**
 * Check if a stage can be skipped.
 * 
 * @param stage - The stage to check
 * @returns True if stage is skippable
 * 
 * @task T4800
 */
export function canSkipStage(stage: Stage): boolean {
  return STAGE_DEFINITIONS[stage].skippable;
}

/**
 * Skip a stage with validation.
 * 
 * @param stage - The stage to skip
 * @param reason - Reason for skipping
 * @param context - State machine context
 * @throws {CleoError} If stage cannot be skipped
 * @returns Updated StageState
 * 
 * @task T4800
 */
export function skipStage(
  stage: Stage,
  _reason: string,
  context: StateMachineContext
): StageState {
  if (!canSkipStage(stage)) {
    throw new CleoError(
      ExitCode.LIFECYCLE_TRANSITION_INVALID,
      `Stage ${stage} cannot be skipped`,
      {
        fix: `Complete the ${stage} stage or use force flag`,
      }
    );
  }
  
  const currentState = context.stages[stage];
  
  if (currentState.status === 'completed') {
    throw new CleoError(
      ExitCode.LIFECYCLE_TRANSITION_INVALID,
      `Cannot skip ${stage}: already completed`
    );
  }
  
  return setStageStatus(stage, 'skipped', context);
}
