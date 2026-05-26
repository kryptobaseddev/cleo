/**
 * saga.add — link a member Epic to a Saga via `parent_id` containment.
 *
 * After T10638 (E10.W5), Saga membership uses canonical `parent_id`
 * containment rather than `task_relations.type='groups'`. Sagas are
 * identified by `type='saga'` (ADR-083 §2.5), not by label.
 *
 * Validates that:
 *   - the saga task exists and has `type='saga'`
 *   - the epic task exists and has `type='epic'`
 *   - the epic is NOT already parented to another saga (idempotent re-add ok)
 *   - the epic candidate is NOT itself a saga (ADR-073 §1.2 invariant I7)
 *
 * Returns an EngineResult — the dispatch layer wraps it in a LAFS envelope.
 *
 * @task T10124
 * @task T10120
 * @task T10118 — wire I7 enforcement gate
 * @task T10638 — E10.W5 type='saga' + parent_id containment
 * @epic T10208
 * @epic T10209 — E-SAGA-ENFORCEMENT
 * @saga T10538 — SG-PM-CORE-V2
 * @see ADR-073-above-epic-naming.md §1
 * @see ADR-083-saga-as-tasktype.md §2.5
 */

import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { taskShow } from '../tasks/show.js';
import { coreTaskReparent } from '../tasks/task-reparent.js';
import { isSagaType } from './is-saga-type.js';
import {
  assertSagaInvariantI7,
  isSagaInvariantViolationError,
  type SagaInvariantViolationError,
} from './enforcement.js';

/** Input parameters for {@link sagaAdd}. */
export interface SagaAddParams {
  /** Saga task ID (must have `type='saga'`). */
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
 * Link an Epic into a Saga as a member via `parent_id` containment.
 * Validates saga/epic preconditions per ADR-073 §1 + ADR-083 §2.5.
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

  // Validate: sagaId must have type='saga'
  const sagaResult = await taskShow(projectRoot, sagaId);
  if (!sagaResult.success || !sagaResult.data) {
    return engineError('E_NOT_FOUND', `Saga not found: ${sagaId}`);
  }
  if (!isSagaType(sagaResult.data.task)) {
    return engineError(
      'E_INVALID_INPUT',
      `Task ${sagaId} has type='${String(sagaResult.data.task.type)}', expected type='saga'`,
    );
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

  // Idempotent: already parented to this saga
  if (epicResult.data.task.parentId === sagaId) {
    return engineSuccess({ sagaId, epicId, added: false });
  }

  // ADR-073 §1.2 invariant I7 — no nested sagas. The candidate epic MUST NOT
  // itself be saga-shaped (type='saga').
  try {
    assertSagaInvariantI7(epicId, epicResult.data.task.labels ?? [], sagaId, epicType);
  } catch (err: unknown) {
    if (isSagaInvariantViolationError(err)) {
      const violation = err as SagaInvariantViolationError;
      return engineError(violation.code, violation.message, {
        details: violation.diag,
        fix: `Epic ${epicId} is itself a saga — nested sagas are forbidden (ADR-073 §1.2 I7).`,
      });
    }
    throw err;
  }

  // Reparent the epic under the saga using parent_id containment
  try {
    const reparentResult = await coreTaskReparent(projectRoot, epicId, sagaId);
    return engineSuccess({
      sagaId,
      epicId,
      added: reparentResult.reparented,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return engineError('E_GENERAL', `Failed to link Epic to Saga via parent_id: ${message}`);
  }
}
