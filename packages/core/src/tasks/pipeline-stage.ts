/**
 * Pipeline stage binding for tasks (RCASD-IVTR+C).
 *
 * Implements auto-assignment of pipeline stages on task creation and
 * forward-only stage transition validation on task update.
 *
 * Stages (in order):
 *   1. research
 *   2. consensus
 *   3. architecture_decision
 *   4. specification
 *   5. decomposition
 *   6. implementation
 *   7. validation
 *   8. testing
 *   9. release
 *  10. contribution  (cross-cutting, treated as terminal)
 *
 * @task T060
 * @epic T056
 */

import type { TaskType } from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../errors.js';

/**
 * Minimal parent task shape needed for pipeline stage resolution.
 * @task T060
 */
export interface ResolvedParent {
  pipelineStage?: string | null;
  type?: TaskType | null;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Ordered pipeline stages (RCASD-IVTR+C).
 * This matches lifecycle/stages.ts PIPELINE_STAGES but is kept local to avoid
 * a circular dependency — tasks/ must not import from lifecycle/.
 *
 * @task T060
 */
export const TASK_PIPELINE_STAGES = [
  'research',
  'consensus',
  'architecture_decision',
  'specification',
  'decomposition',
  'implementation',
  'validation',
  'testing',
  'release',
  'contribution',
] as const;

/** Union type of all valid pipeline stage names. */
export type TaskPipelineStage = (typeof TASK_PIPELINE_STAGES)[number];

/** Order map for fast index lookups (1-based). */
const STAGE_ORDER: Record<TaskPipelineStage, number> = {
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

// =============================================================================
// VALIDATION
// =============================================================================

/**
 * Check whether a string is a valid pipeline stage name.
 *
 * @remarks
 * Uses a type-narrowing signature so callers can safely use the value
 * as {@link TaskPipelineStage} after a truthy check.
 *
 * @param stage - Raw string to test
 * @returns True if it is a valid stage name
 *
 * @example
 * ```ts
 * isValidPipelineStage('research');       // => true
 * isValidPipelineStage('not_a_stage');    // => false
 * ```
 *
 * @task T060
 */
export function isValidPipelineStage(stage: string): stage is TaskPipelineStage {
  return TASK_PIPELINE_STAGES.includes(stage as TaskPipelineStage);
}

/**
 * Validate a pipeline stage name and throw a CleoError on failure.
 *
 * @remarks
 * Uses an assertion signature — after a successful call the compiler
 * narrows `stage` to {@link TaskPipelineStage}.
 *
 * @param stage - Stage name to validate
 * @returns void (assertion function — narrows type on success)
 * @throws CleoError(VALIDATION_ERROR) if invalid
 *
 * @example
 * ```ts
 * validatePipelineStage('implementation'); // passes
 * validatePipelineStage('invalid');        // throws CleoError
 * ```
 *
 * @task T060
 */
export function validatePipelineStage(stage: string): asserts stage is TaskPipelineStage {
  if (!isValidPipelineStage(stage)) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `Invalid pipeline stage: "${stage}". Valid stages: ${TASK_PIPELINE_STAGES.join(', ')}`,
      { fix: `Use one of: ${TASK_PIPELINE_STAGES.join(', ')}` },
    );
  }
}

// =============================================================================
// AUTO-ASSIGNMENT
// =============================================================================

/**
 * Determine the default pipeline stage for a new task.
 *
 * Rules (in priority order):
 * 1. If an explicit stage is provided and valid, use it.
 * 2. If the task has a parent, inherit the parent's pipelineStage.
 * 3. If the task type is 'epic', default to 'research'.
 * 4. Otherwise default to 'implementation'.
 *
 * @remarks
 * Priority order ensures explicit caller intent wins, then parent
 * inheritance, then type-based defaults. This avoids surprising
 * overrides when parent stages differ from the default.
 *
 * @param options - Resolution inputs
 * @param options.explicitStage - Stage explicitly provided by the caller
 * @param options.taskType      - Type of the task being created
 * @param options.parentTask    - Parent task (if any), for inheritance
 * @returns The resolved pipeline stage name
 *
 * @example
 * ```ts
 * resolveDefaultPipelineStage({ taskType: 'epic' });
 * // => 'research'
 *
 * resolveDefaultPipelineStage({ taskType: 'task' });
 * // => 'implementation'
 * ```
 *
 * @task T060
 */
export function resolveDefaultPipelineStage(options: {
  explicitStage?: string | null;
  taskType?: TaskType | null;
  parentTask?: ResolvedParent | null;
}): TaskPipelineStage {
  const { explicitStage, taskType, parentTask } = options;

  // 1. Caller-supplied explicit stage (validated upstream)
  if (explicitStage && isValidPipelineStage(explicitStage)) {
    return explicitStage;
  }

  // 2. Inherit from parent
  if (parentTask?.pipelineStage && isValidPipelineStage(parentTask.pipelineStage)) {
    return parentTask.pipelineStage;
  }

  // 3. Epic → research
  if (taskType === 'epic') {
    return 'research';
  }

  // 4. Default
  return 'implementation';
}

// =============================================================================
// TRANSITION VALIDATION
// =============================================================================

/**
 * Get the numeric order of a pipeline stage (1-based).
 *
 * @remarks
 * Returns -1 for unrecognised stage names so callers can distinguish
 * "unknown" from a valid low-order stage.
 *
 * @param stage - Stage name (must be valid)
 * @returns Numeric order (1–10), or -1 if not found
 *
 * @example
 * ```ts
 * getPipelineStageOrder('research');       // => 1
 * getPipelineStageOrder('implementation'); // => 6
 * getPipelineStageOrder('unknown');        // => -1
 * ```
 *
 * @task T060
 */
export function getPipelineStageOrder(stage: string): number {
  return isValidPipelineStage(stage) ? STAGE_ORDER[stage] : -1;
}

/**
 * Check whether transitioning from `currentStage` to `newStage` is forward-only.
 *
 * "Forward" means the new stage's order is greater than or equal to the current
 * stage's order (same stage is a no-op and is considered valid).
 *
 * @remarks
 * Unknown stages are treated as valid to avoid blocking tasks with
 * legacy or custom stage names that predate the standard set.
 *
 * @param currentStage - The task's current pipeline stage
 * @param newStage     - The requested new pipeline stage
 * @returns True if the transition is allowed (forward or same)
 *
 * @example
 * ```ts
 * isPipelineTransitionForward('research', 'implementation'); // => true
 * isPipelineTransitionForward('testing', 'research');        // => false
 * ```
 *
 * @task T060
 */
export function isPipelineTransitionForward(currentStage: string, newStage: string): boolean {
  const currentOrder = getPipelineStageOrder(currentStage);
  const newOrder = getPipelineStageOrder(newStage);
  if (currentOrder === -1 || newOrder === -1) return true; // unknown stages: allow
  return newOrder >= currentOrder;
}

/**
 * Validate a pipeline stage transition and throw if it would move backward.
 *
 * @remarks
 * Validates the new stage name first via {@link validatePipelineStage},
 * then checks directionality. A null/undefined current stage accepts any
 * valid new stage (first assignment).
 *
 * @param currentStage - The task's current pipeline stage (may be null/undefined)
 * @param newStage     - The new stage being requested
 * @throws CleoError(VALIDATION_ERROR) if the transition is backward
 *
 * @example
 * ```ts
 * validatePipelineTransition(null, 'research');              // passes (first assignment)
 * validatePipelineTransition('research', 'implementation');   // passes (forward)
 * validatePipelineTransition('testing', 'research');          // throws (backward)
 * ```
 *
 * @task T060
 */
export function validatePipelineTransition(
  currentStage: string | null | undefined,
  newStage: string,
): void {
  // Validate the new stage name first
  validatePipelineStage(newStage);

  if (!currentStage) {
    // No current stage — any valid stage is allowed
    return;
  }

  if (!isPipelineTransitionForward(currentStage, newStage)) {
    const currentOrder = getPipelineStageOrder(currentStage);
    const newOrder = getPipelineStageOrder(newStage);
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `Pipeline stage transition rejected: cannot move backward from "${currentStage}" (order ${currentOrder}) to "${newStage}" (order ${newOrder}). Tasks can only move forward through pipeline stages.`,
      {
        fix: `Specify a stage at or after "${currentStage}". Valid forward stages: ${TASK_PIPELINE_STAGES.filter((s) => STAGE_ORDER[s] >= currentOrder).join(', ')}`,
      },
    );
  }
}
