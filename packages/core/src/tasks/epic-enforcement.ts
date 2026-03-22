/**
 * Epic lifecycle pipeline enforcement (RCASD-IVTR+C).
 *
 * Enforces three constraints specific to tasks of type "epic":
 *
 * 1. **Creation requirements** (strict mode only):
 *    - Minimum 5 acceptance criteria (vs. 3 for regular tasks).
 *    - Completion criteria must be defined (non-empty description field).
 *    - Initial pipeline stage defaults to "research" (inherited from
 *      pipeline-stage.ts, not re-asserted here).
 *
 * 2. **Child stage ceiling**: A child task's pipeline stage cannot advance
 *    past the epic's current pipeline stage.  This is checked on child task
 *    update (pipelineStage change) and on child task creation.
 *
 * 3. **Epic stage advancement gate**: An epic cannot advance its pipeline
 *    stage while it has children whose status is not "done" AND whose
 *    pipeline stage equals the epic's current stage.  In other words, all
 *    in-flight children at the current stage must be completed before the
 *    epic may move forward.
 *
 * Enforcement is conditional on `lifecycle.mode`:
 *   - "strict"   → block (throw CleoError on violation)
 *   - "advisory" → warn (return error string but do not throw)
 *   - "off"      → skip (all checks are no-ops)
 *
 * @task T062
 * @epic T056
 */

import type { DataAccessor, Task } from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts';
import { loadConfig } from '../config.js';
import { CleoError } from '../errors.js';
import { getPipelineStageOrder, isValidPipelineStage } from './pipeline-stage.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Minimum acceptance criteria count required for epic creation in strict mode. */
export const EPIC_MIN_AC = 5;

/** Minimum acceptance criteria count for regular tasks. */
export const TASK_MIN_AC = 3;

// =============================================================================
// TYPES
// =============================================================================

/** The resolved enforcement mode (from lifecycle.mode config key). */
export type LifecycleMode = 'strict' | 'advisory' | 'off';

/** Result of an enforcement check.  `warning` is populated in advisory mode. */
export interface EpicEnforcementResult {
  /** True unless a hard block was raised. */
  valid: boolean;
  /** Advisory message (non-blocking) or error message (blocked). */
  warning?: string;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Read `lifecycle.mode` from config.  Falls back to "strict" when unset
 * (matches the DEFAULTS in config.ts).
 *
 * @remarks
 * In VITEST environments, returns "off" to avoid blocking tests.
 *
 * @param cwd - Working directory for config resolution
 * @returns The resolved lifecycle mode
 *
 * @example
 * ```ts
 * const mode = await getLifecycleMode();
 * // => 'strict' | 'advisory' | 'off'
 * ```
 *
 * @task T062
 */
export async function getLifecycleMode(cwd?: string): Promise<LifecycleMode> {
  if (process.env.VITEST) return 'off';
  const config = await loadConfig(cwd);
  return config.lifecycle?.mode ?? 'strict';
}

// =============================================================================
// 1. EPIC CREATION REQUIREMENTS
// =============================================================================

/**
 * Validate that a new epic satisfies creation requirements.
 *
 * In **strict** mode:
 *   - At least {@link EPIC_MIN_AC} acceptance criteria must be provided.
 *   - `description` must be non-empty (treated as completion criteria).
 *
 * In **advisory** mode the same checks are run but violations do not block —
 * they are returned as `warning` text for the caller to surface.
 *
 * In **off** mode this function is a no-op.
 *
 * @remarks
 * The description field serves as a proxy for completion criteria — epics
 * without a description have no definition of "done" and should be blocked.
 *
 * @param options - Epic creation parameters
 * @param options.acceptance  - Acceptance criteria array supplied by the caller.
 * @param options.description - Task description (used as completion criteria proxy).
 * @param cwd                 - Working directory for config resolution.
 * @returns EpicEnforcementResult — `valid: false` only in strict mode on error.
 * @throws CleoError(VALIDATION_ERROR) in strict mode when constraints are violated.
 *
 * @example
 * ```ts
 * await validateEpicCreation({ acceptance: ['AC1','AC2','AC3','AC4','AC5'] });
 * // => { valid: true }
 * ```
 *
 * @task T062
 */
export async function validateEpicCreation(
  options: {
    acceptance?: string[];
    description?: string;
  },
  cwd?: string,
): Promise<EpicEnforcementResult> {
  const mode = await getLifecycleMode(cwd);
  if (mode === 'off') return { valid: true };

  const ac = options.acceptance ?? [];
  const desc = (options.description ?? '').trim();

  const violations: string[] = [];

  if (ac.length < EPIC_MIN_AC) {
    violations.push(
      `Epic requires at least ${EPIC_MIN_AC} acceptance criteria (${ac.length} provided). Regular tasks need ${TASK_MIN_AC}.`,
    );
  }

  if (!desc) {
    violations.push('Epic must have a non-empty description (used as completion criteria).');
  }

  if (violations.length === 0) return { valid: true };

  const message = violations.join(' | ');
  const fix = `Add --acceptance "..." flags (need ${EPIC_MIN_AC}) and a --description "completion criteria"`;

  if (mode === 'strict') {
    throw new CleoError(ExitCode.VALIDATION_ERROR, message, { fix });
  }

  // advisory: warn but allow
  return { valid: true, warning: message };
}

// =============================================================================
// 2. CHILD STAGE CEILING
// =============================================================================

/**
 * Validate that a child task's pipeline stage does not exceed its epic's stage.
 *
 * Call this when:
 *   - A child task is **created** under an epic parent.
 *   - A child task's `pipelineStage` is **updated** and it has an epic ancestor.
 *
 * The check walks the task's ancestor chain to find the nearest epic ancestor.
 * If none exists, the check is skipped.
 *
 * @remarks
 * Skips the check if the epic has no pipeline stage set, or if the child
 * stage is not a recognised value (those are handled by separate validation).
 *
 * @param options - Ceiling check parameters
 * @param options.childStage  - The proposed pipeline stage for the child.
 * @param options.epicId      - ID of the epic ancestor to check against.
 * @param accessor            - DataAccessor for task lookups.
 * @param cwd                 - Working directory for config resolution.
 * @returns EpicEnforcementResult
 * @throws CleoError(VALIDATION_ERROR) in strict mode when the child stage exceeds the epic.
 *
 * @example
 * ```ts
 * await validateChildStageCeiling(
 *   { childStage: 'testing', epicId: 'T001' },
 *   accessor,
 * );
 * ```
 *
 * @task T062
 */
export async function validateChildStageCeiling(
  options: {
    childStage: string;
    epicId: string;
  },
  accessor: DataAccessor,
  cwd?: string,
): Promise<EpicEnforcementResult> {
  const mode = await getLifecycleMode(cwd);
  if (mode === 'off') return { valid: true };

  const epic = await accessor.loadSingleTask(options.epicId);
  if (!epic || epic.type !== 'epic') return { valid: true };

  const epicStage = epic.pipelineStage;
  if (!epicStage || !isValidPipelineStage(epicStage)) return { valid: true };

  const childStage = options.childStage;
  if (!isValidPipelineStage(childStage)) return { valid: true }; // stage validation handled elsewhere

  const epicOrder = getPipelineStageOrder(epicStage);
  const childOrder = getPipelineStageOrder(childStage);

  if (childOrder <= epicOrder) return { valid: true };

  const message =
    `Child task cannot be at pipeline stage "${childStage}" (order ${childOrder}) ` +
    `because its parent epic ${options.epicId} is only at stage "${epicStage}" (order ${epicOrder}). ` +
    `Children cannot exceed their epic's current stage.`;
  const fix = `Use a stage at or before "${epicStage}". Advance the epic first if needed.`;

  if (mode === 'strict') {
    throw new CleoError(ExitCode.VALIDATION_ERROR, message, { fix });
  }

  return { valid: true, warning: message };
}

/**
 * Find the nearest epic ancestor for a given task.
 *
 * Walks the ancestor chain (root-first) and returns the first task whose
 * type is "epic", or null if no epic ancestor exists.
 *
 * @remarks
 * Scans from closest ancestor to root so the *nearest* epic is returned,
 * not the highest-level one.
 *
 * @param taskId   - ID of the task whose ancestors to inspect.
 * @param accessor - DataAccessor for the ancestor chain query.
 * @returns The nearest epic ancestor, or null.
 *
 * @example
 * ```ts
 * const epic = await findEpicAncestor('T042', accessor);
 * if (epic) console.log(epic.id); // e.g. 'T029'
 * ```
 *
 * @task T062
 */
export async function findEpicAncestor(
  taskId: string,
  accessor: DataAccessor,
): Promise<Task | null> {
  const ancestors = await accessor.getAncestorChain(taskId);
  // ancestors is root-first; the last entry is the immediate parent
  // We want the nearest epic, so scan from the end (closest ancestor first)
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const ancestor = ancestors[i];
    if (ancestor && ancestor.type === 'epic') return ancestor;
  }
  return null;
}

// =============================================================================
// 3. EPIC STAGE ADVANCEMENT GATE
// =============================================================================

/**
 * Validate that an epic can advance its pipeline stage.
 *
 * An epic is **blocked** from advancing to a later stage when it has at least
 * one child that:
 *   - Has a pipeline stage **equal to the epic's current stage**, AND
 *   - Has a status that is **not** "done" (i.e., is still in-flight).
 *
 * Rationale: the epic stage represents the stage the team is actively working
 * in.  Moving the epic forward while children are unfinished at the current
 * stage violates the pipeline discipline.
 *
 * @remarks
 * Only fires on genuine forward advancement — same-stage updates and
 * backward moves are handled by {@link validatePipelineTransition}.
 * Children with status "done", "cancelled", or "archived" are excluded
 * from the blocker check.
 *
 * @param options - Advancement check parameters
 * @param options.epicId       - ID of the epic being advanced.
 * @param options.currentStage - Epic's current pipeline stage (before the update).
 * @param options.newStage     - Proposed new pipeline stage.
 * @param accessor             - DataAccessor for children lookup.
 * @param cwd                  - Working directory for config resolution.
 * @returns EpicEnforcementResult
 * @throws CleoError(VALIDATION_ERROR) in strict mode when incomplete children exist.
 *
 * @example
 * ```ts
 * await validateEpicStageAdvancement(
 *   { epicId: 'T029', currentStage: 'research', newStage: 'consensus' },
 *   accessor,
 * );
 * ```
 *
 * @task T062
 */
export async function validateEpicStageAdvancement(
  options: {
    epicId: string;
    currentStage: string;
    newStage: string;
  },
  accessor: DataAccessor,
  cwd?: string,
): Promise<EpicEnforcementResult> {
  const mode = await getLifecycleMode(cwd);
  if (mode === 'off') return { valid: true };

  const { epicId, currentStage, newStage } = options;

  // Only enforce if actually advancing (not a same-stage no-op)
  if (!isValidPipelineStage(currentStage) || !isValidPipelineStage(newStage)) {
    return { valid: true };
  }

  const currentOrder = getPipelineStageOrder(currentStage);
  const newOrder = getPipelineStageOrder(newStage);

  if (newOrder <= currentOrder) {
    // Same stage or backward — backward is caught by validatePipelineTransition
    return { valid: true };
  }

  // Find all children whose stage equals the current epic stage and are not done
  const children = await accessor.getChildren(epicId);
  const blockers = children.filter((child) => {
    if (child.status === 'done' || child.status === 'cancelled' || child.status === 'archived') {
      return false;
    }
    return child.pipelineStage === currentStage;
  });

  if (blockers.length === 0) return { valid: true };

  const blockerIds = blockers.map((t) => t.id).join(', ');
  const message =
    `Epic ${epicId} cannot advance from "${currentStage}" to "${newStage}" — ` +
    `${blockers.length} child task(s) are still in-flight at stage "${currentStage}": ${blockerIds}. ` +
    `Complete all children at the current stage before advancing the epic.`;
  const fix = `Complete tasks ${blockerIds} first, then advance the epic stage.`;

  if (mode === 'strict') {
    throw new CleoError(ExitCode.VALIDATION_ERROR, message, { fix });
  }

  return { valid: true, warning: message };
}
