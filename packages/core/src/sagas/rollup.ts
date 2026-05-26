/**
 * saga.rollup — aggregate member Epic statuses for a Saga.
 *
 * Reads every member Epic via parent_id containment and tallies their
 * statuses into a structured counter (done/active/blocked/pending +
 * completionPct).
 *
 * Returns an EngineResult; the dispatch layer wraps it in a LAFS envelope.
 *
 * Moved from `packages/cleo/src/dispatch/domains/tasks.ts::sagaRollup` per
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
import { taskShow } from '../tasks/show.js';
import { resolveSagaMemberIds } from './storage.js';

/** Input parameters for {@link sagaRollup}. */
export interface SagaRollupParams {
  /** Saga task ID whose members to roll up. */
  sagaId: string;
}

/** Result payload for {@link sagaRollup}. */
export interface SagaRollupResult {
  sagaId: string;
  total: number;
  done: number;
  active: number;
  blocked: number;
  pending: number;
  completionPct: number;
}

/**
 * Compute completion rollup for a Saga over its member Epics.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param params - sagaId of the Saga to roll up.
 */
export async function sagaRollup(
  projectRoot: string,
  params: SagaRollupParams,
): Promise<EngineResult<SagaRollupResult>> {
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
    const total = memberIds.length;
    if (total === 0) {
      return engineSuccess({
        sagaId,
        total: 0,
        done: 0,
        active: 0,
        blocked: 0,
        pending: 0,
        completionPct: 0,
      });
    }
    const shows = await Promise.all(memberIds.map((id) => taskShow(projectRoot, id)));
    let done = 0;
    let active = 0;
    let blocked = 0;
    let pending = 0;
    for (const r of shows) {
      if (!r.success) continue;
      const status = r.data?.task.status ?? 'pending';
      if (status === 'done') done++;
      else if (status === 'active') active++;
      else if (status === 'blocked') blocked++;
      else pending++;
    }
    const completionPct = total > 0 ? Math.round((done / total) * 100) : 0;
    return engineSuccess({ sagaId, total, done, active, blocked, pending, completionPct });
  } finally {
    await accessor.close();
  }
}
