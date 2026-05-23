/**
 * saga.members — list member Epics linked to a Saga via type='groups'.
 *
 * Returns the relation rows in the order they were stored. Returns an
 * EngineResult; the dispatch layer wraps it in a LAFS envelope.
 *
 * Moved from `packages/cleo/src/dispatch/domains/tasks.ts::sagaMembers` per
 * AGENTS.md Package-Boundary Check (Saga T10113 / Epic T10208).
 *
 * @task T10124
 * @task T10120
 * @epic T10208
 * @see ADR-073-above-epic-naming.md §1
 */

import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { taskRelates } from '../tasks/task-ops.js';
import { SAGA_GROUPS_RELATION } from './constants.js';

/** Input parameters for {@link sagaMembers}. */
export interface SagaMembersParams {
  /** Saga task ID whose members to list. */
  sagaId: string;
}

/** Single member entry for {@link sagaMembers}. */
export interface SagaMemberEntry {
  epicId: string;
  type: string;
  reason?: string;
}

/** Result payload for {@link sagaMembers}. */
export interface SagaMembersResult {
  sagaId: string;
  members: SagaMemberEntry[];
  total: number;
}

/**
 * List the member Epics for a Saga (relations with type='groups').
 *
 * @param projectRoot - Absolute path to the project root.
 * @param params - sagaId of the Saga whose members to list.
 */
export async function sagaMembers(
  projectRoot: string,
  params: SagaMembersParams,
): Promise<EngineResult<SagaMembersResult>> {
  const sagaId = params.sagaId;
  if (!sagaId) {
    return engineError('E_INVALID_INPUT', 'sagaId is required');
  }
  const result = await taskRelates(projectRoot, sagaId);
  if (!result.success) {
    return engineError('E_GENERAL', result.error?.message ?? 'Failed to list Saga members');
  }
  const relations = result.data?.relations ?? [];
  const members = relations.filter((r) => r.type === SAGA_GROUPS_RELATION);
  return engineSuccess({
    sagaId,
    members: members.map((r) => ({ epicId: r.taskId, type: r.type, reason: r.reason })),
    total: members.length,
  });
}
