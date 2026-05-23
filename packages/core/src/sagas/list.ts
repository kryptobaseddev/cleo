/**
 * saga.list — list all Sagas (labeled top-level Epics).
 *
 * Filters for `type='epic'` + `label='saga'` and excludes rows with a
 * `parentId` so only top-level Sagas surface.
 *
 * NOTE — the `!parentId` filter has a known bug (T10117 — Sagas with a
 * non-null parentId are silently dropped). T10117 fixes it in a separate
 * PR; this extraction MUST preserve the existing behavior so snapshot
 * tests do not change.
 *
 * Moved from `packages/cleo/src/dispatch/domains/tasks.ts::sagaList` per
 * AGENTS.md Package-Boundary Check (Saga T10113 / Epic T10208).
 *
 * @task T10124
 * @task T10120
 * @epic T10208
 * @see ADR-073-above-epic-naming.md §1
 */

import type { TaskRecord } from '@cleocode/contracts';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { type CompactTask, taskList } from '../tasks/list.js';

/** Result payload for {@link sagaList}. */
export interface SagaListResult {
  sagas: Array<TaskRecord | CompactTask>;
  total: number;
}

/**
 * List all top-level Sagas (Epics with `label='saga'` and no parentId).
 *
 * @param projectRoot - Absolute path to the project root.
 */
export async function sagaList(projectRoot: string): Promise<EngineResult<SagaListResult>> {
  const result = await taskList(projectRoot, { type: 'epic', label: 'saga' });
  if (!result.success) {
    return engineError('E_GENERAL', result.error?.message ?? 'Failed to list Sagas');
  }
  const tasks = result.data?.tasks ?? [];
  // Filter to top-level only (no parent). This preserves the historical
  // behavior; the bug is fixed under T10117.
  const topLevel = tasks.filter((t) => {
    const parentId = (t as { parentId?: string | null }).parentId;
    return !parentId;
  });
  return engineSuccess({ sagas: topLevel, total: topLevel.length });
}
