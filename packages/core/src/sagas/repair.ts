/**
 * saga.repair — detach an I5-violating parent edge from a Saga.
 *
 * A Saga (Epic with `label='saga'`) MUST link to other sagas / member epics
 * via `task_relations.type='groups'`, NOT via the `parentId` column
 * (ADR-073 §1.2 invariant I5). This verb repairs a saga that was created
 * before T10117 enforced the invariant:
 *
 * 1. Loads the saga and confirms `labels.includes('saga')`.
 * 2. If `parentId` is `null`, returns idempotently (no-op).
 * 3. Otherwise: clears `parentId` to `null` and writes a `groups` edge from
 *    the former parent → the saga so the membership semantics are preserved.
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
import { taskRelatesAdd } from '../tasks/engine-wrap.js';
import { taskShow } from '../tasks/show.js';
import { coreTaskReparent } from '../tasks/task-reparent.js';
import { SAGA_GROUPS_RELATION } from './constants.js'; // saga-label-ok: T10638 — SSoT residual

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
   * `true` when the call performed a state change (detached `parentId`,
   * added a `groups` edge), `false` when the saga already satisfied I5.
   */
  repaired: boolean;
  /**
   * The `parentId` value that was detached. `null` when no detach was needed.
   */
  detachedParentId: string | null;
  /**
   * The relation that was written to replace the parent edge. `null` when
   * no rewrite was needed (idempotent no-op) or when the former parent no
   * longer exists in the store (in which case the `parentId` is still
   * cleared, but no `groups` edge is added — see `note`).
   */
  attachedRelation: {
    from: string;
    to: string;
    type: typeof SAGA_GROUPS_RELATION;
  } | null;
  /**
   * Free-form notes the caller can surface in CLI output, e.g. when the
   * former parent could not be found and only the detach half completed.
   */
  note?: string;
}

/**
 * Repair an I5-violating saga by detaching its `parentId` and re-attaching
 * the former parent via `task_relations.type='groups'`.
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
      attachedRelation: null,
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

  // Step 2: re-attach the former parent as a `groups` edge so the
  // membership semantics survive. We tolerate the case where the former
  // parent has since been deleted — the I5 violation is gone either way.
  const parentExists = await taskShow(projectRoot, currentParentId);
  if (!parentExists.success || !parentExists.data) {
    return engineSuccess({
      sagaId,
      repaired: true,
      detachedParentId: currentParentId,
      attachedRelation: null,
      note: `Former parent ${currentParentId} not found — parentId was cleared but no groups edge was written.`,
    });
  }

  const relResult = await taskRelatesAdd(
    projectRoot,
    currentParentId,
    sagaId,
    SAGA_GROUPS_RELATION,
    `Repaired I5 violation via cleo saga repair ${sagaId} (T10117)`,
  );
  if (!relResult.success) {
    return engineError(
      'E_GENERAL',
      `Detached parentId on ${sagaId} but failed to write groups edge: ${
        relResult.error?.message ?? 'unknown error'
      }`,
    );
  }

  return engineSuccess({
    sagaId,
    repaired: true,
    detachedParentId: currentParentId,
    attachedRelation: {
      from: currentParentId,
      to: sagaId,
      type: SAGA_GROUPS_RELATION,
    },
  });
}
