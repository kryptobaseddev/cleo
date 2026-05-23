/**
 * Saga storage helpers — direct DataAccessor reads scoped to the Saga model.
 *
 * Lives in `packages/core/src/sagas/` so the dispatch layer (and any other
 * Saga-aware caller) imports a single helper rather than re-deriving the
 * label / relation-type / member-walk logic locally.
 *
 * Moved from `packages/core/src/tasks/list.ts` (where it shipped as a
 * file-local `resolveSagaMemberIds`) per Saga T10113 / Epic T10208.
 *
 * @task T10123
 * @task T10120
 * @epic T10208
 * @see ADR-073-above-epic-naming.md §1
 */

import type { DataAccessor } from '../store/data-accessor.js';
import { SAGA_GROUPS_RELATION, SAGA_LABEL } from './constants.js';

/**
 * Resolve Saga member Epic IDs through `task_relations.type='groups'` edges.
 *
 * Sagas (Epics with `labels` containing `'saga'`) hold their member Epics via
 * `task_relations.type='groups'` rows, not via the `parentId` column. This
 * helper loads the saga task, walks its populated `relates` array, and
 * returns the member task IDs in stable order.
 *
 * Reused by `listTasks` when `--parent` targets a Saga to mirror the
 * resolution `tasks.saga.members` performs at the dispatch layer (ADR-073).
 *
 * @param accessor - Data accessor backing the lookup.
 * @param sagaId - The Saga task ID (must have `labels.includes('saga')`).
 * @returns Member Epic IDs (deduplicated, insertion-order stable). Empty if
 *          the saga has no `groups` edges. `null` if no task with `sagaId`
 *          exists or the task is not labeled `'saga'`.
 *
 * @task T9658
 * @task T10123
 * @see ADR-073-above-epic-naming.md §1
 */
export async function resolveSagaMemberIds(
  accessor: DataAccessor,
  sagaId: string,
): Promise<string[] | null> {
  const sagaTask = await accessor.loadSingleTask(sagaId);
  if (!sagaTask) return null;
  if (!(sagaTask.labels ?? []).includes(SAGA_LABEL)) return null;
  const seen = new Set<string>();
  const memberIds: string[] = [];
  for (const relation of sagaTask.relates ?? []) {
    if (relation.type !== SAGA_GROUPS_RELATION) continue;
    if (seen.has(relation.taskId)) continue;
    seen.add(relation.taskId);
    memberIds.push(relation.taskId);
  }
  return memberIds;
}
