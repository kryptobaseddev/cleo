/**
 * saga.members — list member Epics linked to a Saga via parent_id containment.
 *
 * After T10637, Saga membership is via `parent_id` containment rather than
 * `task_relations.type='groups'`. Member Epics carry `parentId` pointing at
 * the Saga. Returns an EngineResult; the dispatch layer wraps it in a LAFS
 * envelope.
 *
 * Moved from `packages/cleo/src/dispatch/domains/tasks.ts::sagaMembers` per
 * AGENTS.md Package-Boundary Check (Saga T10113 / Epic T10208).
 *
 * @task T10124
 * @task T10120
 * @task T10638 — E10.W5 switch to parent_id containment
 * @epic T10208
 * @see ADR-073-above-epic-naming.md §1
 */

import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { resolveSagaMemberIds } from './storage.js';

/** Input parameters for {@link sagaMembers}. */
export interface SagaMembersParams {
  /** Saga task ID whose members to list. */
  sagaId: string;
}

/** Single member entry for {@link sagaMembers}. */
export interface SagaMemberEntry {
  epicId: string;
}

/** Result payload for {@link sagaMembers}. */
export interface SagaMembersResult {
  sagaId: string;
  members: SagaMemberEntry[];
  total: number;
}

/**
 * List the member Epics for a Saga via parent_id containment.
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
  const accessor = await getTaskAccessor(projectRoot);
  try {
    const memberIds = await resolveSagaMemberIds(accessor, sagaId);
    if (memberIds === null) {
      return engineError('E_NOT_FOUND', `Saga ${sagaId} not found or is not a saga`);
    }
    const members = memberIds.map((epicId) => ({ epicId }));
    return engineSuccess({ sagaId, members, total: members.length });
  } finally {
    await accessor.close();
  }
}
