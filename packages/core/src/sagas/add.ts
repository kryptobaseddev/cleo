/**
 * saga.add — link a member Epic to a Saga via `task_relations.type='groups'`.
 *
 * Validates that:
 *   - the saga task exists and carries `label='saga'`
 *   - the epic task exists and has `type='epic'`
 *
 * Returns an EngineResult — the dispatch layer wraps it in a LAFS envelope.
 *
 * Moved from `packages/cleo/src/dispatch/domains/tasks.ts::sagaAdd` per
 * AGENTS.md Package-Boundary Check (Saga T10113 / Epic T10208).
 *
 * @task T10124
 * @task T10120
 * @epic T10208
 * @see ADR-073-above-epic-naming.md §1
 */

import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { taskShow } from '../tasks/show.js';
import { taskRelatesAdd } from '../tasks/task-ops.js';
import { SAGA_GROUPS_RELATION, SAGA_LABEL } from './constants.js';

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
  if (!sagaLabels.includes(SAGA_LABEL)) {
    return engineError('E_INVALID_INPUT', `Task ${sagaId} does not have label='${SAGA_LABEL}'`);
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

  const relResult = await taskRelatesAdd(projectRoot, sagaId, epicId, SAGA_GROUPS_RELATION);
  if (!relResult.success) {
    return engineError('E_GENERAL', relResult.error?.message ?? 'Failed to link Epic to Saga');
  }
  return engineSuccess({ sagaId, epicId, added: relResult.data?.added ?? true });
}
