/**
 * saga.rollup — aggregate member Epic statuses for a Saga.
 *
 * Reads every member Epic and tallies their statuses into a structured
 * counter (done/active/blocked/pending + completionPct).
 *
 * Returns an EngineResult; the dispatch layer wraps it in a LAFS envelope.
 *
 * Moved from `packages/cleo/src/dispatch/domains/tasks.ts::sagaRollup` per
 * AGENTS.md Package-Boundary Check (Saga T10113 / Epic T10208).
 *
 * @task T10124
 * @task T10120
 * @epic T10208
 * @see ADR-073-above-epic-naming.md §1
 */

import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { taskShow } from '../tasks/show.js';
import { taskRelates } from '../tasks/task-ops.js';
import { SAGA_GROUPS_RELATION } from './constants.js';

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
  const relResult = await taskRelates(projectRoot, sagaId);
  if (!relResult.success) {
    return engineError(
      'E_GENERAL',
      relResult.error?.message ?? 'Failed to fetch Saga members for rollup',
    );
  }
  const members = (relResult.data?.relations ?? []).filter((r) => r.type === SAGA_GROUPS_RELATION);
  const total = members.length;
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
  const shows = await Promise.all(members.map((m) => taskShow(projectRoot, m.taskId)));
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
}
