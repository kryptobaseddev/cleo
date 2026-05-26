/**
 * saga.add — link a member Epic to a Saga via `task_relations.type='groups'`.
 *
 * Validates that:
 *   - the saga task exists and carries `label='saga'`
 *   - the epic task exists and has `type='epic'`
 *   - the epic candidate is NOT itself a saga (ADR-073 §1.2 invariant I7 —
 *     wired in T10118 via `assertSagaInvariantI7`)
 *
 * Returns an EngineResult — the dispatch layer wraps it in a LAFS envelope.
 *
 * Moved from `packages/cleo/src/dispatch/domains/tasks.ts::sagaAdd` per
 * AGENTS.md Package-Boundary Check (Saga T10113 / Epic T10208).
 *
 * @task T10124
 * @task T10120
 * @task T10118 — wire I7 enforcement gate before persisting
 * @epic T10208
 * @epic T10209 — E-SAGA-ENFORCEMENT
 * @see ADR-073-above-epic-naming.md §1
 */

import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { taskShow } from '../tasks/show.js';
import { taskRelatesAdd } from '../tasks/task-ops.js';
import { SAGA_GROUPS_RELATION, SAGA_LABEL } from './constants.js'; // saga-label-ok: T10638 — SSoT residual
import {
  assertSagaInvariantI7,
  isSagaInvariantViolationError,
  type SagaInvariantViolationError,
} from './enforcement.js';

/** Input parameters for {@link sagaAdd}. */
export interface SagaAddParams {
  /** Saga task ID (must have `label='saga'`). */
  sagaId: string;
  /** Epic task ID to link (must have `type='epic'`). */
  epicId: string;
}

/** Result payload for {@link sagaAdd}. */
export interface SagaAddResult {
  sagaId: string;
  epicId: string;
  added: boolean;
}

/**
 * Link an Epic into a Saga as a member, via a `task_relations.type='groups'`
 * edge. Validates the saga / epic preconditions per ADR-073 §1.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param params - sagaId + epicId to link.
 */
export async function sagaAdd(
  projectRoot: string,
  params: SagaAddParams,
): Promise<EngineResult<SagaAddResult>> {
  const sagaId = params.sagaId;
  const epicId = params.epicId;
  if (!sagaId || !epicId) {
    return engineError('E_INVALID_INPUT', 'sagaId and epicId are required');
  }

  // Validate: sagaId must have label='saga'
  const sagaResult = await taskShow(projectRoot, sagaId);
  if (!sagaResult.success || !sagaResult.data) {
    return engineError('E_NOT_FOUND', `Saga not found: ${sagaId}`);
  }
  const sagaLabels: string[] = sagaResult.data.task.labels ?? [];
  if (!sagaLabels.includes(SAGA_LABEL)) { // saga-label-ok: T10638 — SSoT residual
    return engineError('E_INVALID_INPUT', `Task ${sagaId} does not have label='${SAGA_LABEL}' // saga-label-ok: T10638`);
  }

  // Validate: epicId must have type='epic'
  const epicResult = await taskShow(projectRoot, epicId);
  if (!epicResult.success || !epicResult.data) {
    return engineError('E_NOT_FOUND', `Epic not found: ${epicId}`);
  }
  const epicType = epicResult.data.task.type;
  if (epicType !== 'epic') {
    return engineError(
      'E_INVALID_INPUT',
      `Task ${epicId} has type='${String(epicType)}', expected type='epic'`,
    );
  }

  // ADR-073 §1.2 invariant I7 — no nested sagas. The candidate epic MUST NOT
  // itself carry label='saga'. Wired in T10118 after T10115 shipped the
  // pure-function guard. The structured `SagaInvariantViolationError` thrown
  // here is converted into a typed `engineError` so the dispatch layer can
  // surface a LAFS envelope with the stable I7 code + diag payload.
  const candidateLabels: readonly string[] = epicResult.data.task.labels ?? [];
  try {
    assertSagaInvariantI7(epicId, candidateLabels, sagaId);
  } catch (err: unknown) {
    if (isSagaInvariantViolationError(err)) {
      const violation = err as SagaInvariantViolationError;
      return engineError(violation.code, violation.message, {
        details: violation.diag,
        fix:
          `Use 'cleo saga detach ${sagaId} ${epicId}' if this row was previously linked, ` +
          'or relabel the candidate so it no longer carries the saga label.',
      });
    }
    throw err;
  }

  const relResult = await taskRelatesAdd(projectRoot, sagaId, epicId, SAGA_GROUPS_RELATION);
  if (!relResult.success) {
    return engineError('E_GENERAL', relResult.error?.message ?? 'Failed to link Epic to Saga');
  }
  return engineSuccess({ sagaId, epicId, added: relResult.data?.added ?? true });
}
