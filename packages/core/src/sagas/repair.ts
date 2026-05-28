/**
 * saga.repair — detach an I5-violating parent edge from a Saga.
 *
 * A Saga (`type='saga'`) MUST be a root node. This verb repairs a saga that
 * carries an invalid `parentId` by clearing that parent edge:
 *
 * 1. Loads the saga and confirms `type='saga'`.
 * 2. If `parentId` is `null`, returns idempotently (no-op).
 * 3. Otherwise: clears `parentId` to `null`.
 *
 * The verb is **idempotent**: calling it twice on the same saga yields the
 * same final state and the second call reports `repaired: false`.
 *
 * @task T10117 — sagaList loud-filter + repair verb
 * @saga T10113
 * @epic T10209
 * @see ADR-073-above-epic-naming.md §1.2 — invariant I5
 */

import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { taskShow } from '../tasks/show.js';
import { coreTaskReparent } from '../tasks/task-reparent.js';

/** Input parameters for {@link repairSaga}. */
export interface RepairSagaParams {
  /** The saga task ID to repair (must have `labels.includes('saga')`). */
  sagaId: string;
}

/** Result payload for {@link repairSaga}. */
export interface RepairSagaResult {
  /** The saga that was inspected. */
  sagaId: string;
  /**
   * `true` when the call performed a state change, `false` when the saga
   * already satisfied I5.
   */
  repaired: boolean;
  /**
   * The `parentId` value that was detached. `null` when no detach was needed.
   */
  detachedParentId: string | null;
  /**
   * Free-form notes the caller can surface in CLI output, e.g. when the
   * former parent could not be found and only the detach half completed.
   */
  note?: string;
}

/**
 * Repair an I5-violating saga by detaching its `parentId`.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param params - Identifies the saga to repair.
 * @returns The repaired state, including whether any mutation occurred.
 */
export async function repairSaga(
  projectRoot: string,
  params: RepairSagaParams,
): Promise<EngineResult<RepairSagaResult>> {
  const sagaId = params.sagaId;
  if (!sagaId) {
    return engineError('E_INVALID_INPUT', 'sagaId is required');
  }

  const sagaResult = await taskShow(projectRoot, sagaId);
  if (!sagaResult.success || !sagaResult.data) {
    return engineError('E_NOT_FOUND', `Saga not found: ${sagaId}`);
  }
  // Post-PM-Core V2: sagas identified by type, not label
  const sagaTask = sagaResult.data.task;
  if (sagaTask.type !== 'saga') {
    return engineError('E_INVALID_INPUT', `Task ${sagaId} is not a saga (type=${sagaTask.type})`);
  }

  const currentParentId = sagaResult.data.task.parentId ?? null;
  if (currentParentId === null) {
    // Idempotent no-op — saga already satisfies I5.
    return engineSuccess({
      sagaId,
      repaired: false,
      detachedParentId: null,
    });
  }

  // Step 1: detach the parent edge via the canonical reparent helper.
  try {
    await coreTaskReparent(projectRoot, sagaId, null);
  } catch (err: unknown) {
    const e = err as { message?: string };
    return engineError(
      'E_GENERAL',
      `Failed to detach parentId from saga ${sagaId}: ${e?.message ?? 'unknown error'}`,
    );
  }

  return engineSuccess({
    sagaId,
    repaired: true,
    detachedParentId: currentParentId,
  });
}
