/**
 * Regression tests for `cleo find --parent <id>` (T10108).
 *
 * Previously `cleo find "" --parent T9758` returned the full unfiltered set
 * because:
 *   1. The CLI `find` command had no `--parent` flag and silently dropped
 *      the value before dispatch.
 *   2. The empty-string `""` query short-circuited to fuzzy-mode where
 *      `fuzzyScore('', '<title>')` returns 80 for every task (substring
 *      match of the empty string), so every row "matched".
 *
 * The fix:
 *   - `FindTasksOptions.parent` is now a first-class filter.
 *   - An empty / whitespace-only `query` is treated as "no query supplied"
 *     so the filter-only path runs.
 *   - `--parent` is Saga-aware — when the target is a Saga (Epic labeled
 *     `saga`), children are resolved through `task_relations.type='groups'`
 *     edges instead of the `parentId` column, matching `listTasks`
 *     (ADR-073 §1).
 *
 * @task T10108
 */

import type { Task } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import type { DataAccessor } from '../../store/data-accessor.js';
import { findTasks } from '../find.js';

/** Build a mock DataAccessor wrapping an in-memory array. */
function mockAccessor(tasks: Task[]): DataAccessor {
  return {
    queryTasks: async (filters) => {
      let list = tasks;
      if (filters?.status) list = list.filter((t) => t.status === filters.status);
      if (filters?.parentId !== undefined) {
        list = list.filter((t) => t.parentId === filters.parentId);
      }
      return { tasks: list, total: list.length };
    },
    loadArchive: async () => ({ archivedTasks: [] }),
    loadSingleTask: async (id: string) => tasks.find((t) => t.id === id) ?? null,
  } as unknown as DataAccessor;
}

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: 'TX',
    title: 't',
    description: '',
    status: 'pending',
    priority: 'medium',
    type: 'task',
    size: 'small',
    parentId: null,
    labels: [],
    depends: [],
    acceptance: [],
    createdAt: '2026-05-23T00:00:00Z',
    ...overrides,
  } as Task;
}

describe('findTasks — --parent filter (T10108)', () => {
  it('restricts results to direct children of --parent', async () => {
    const tasks = [
      makeTask({ id: 'T100', title: 'epic parent', type: 'epic', parentId: null }),
      makeTask({ id: 'T101', title: 'child A', parentId: 'T100' }),
      makeTask({ id: 'T102', title: 'child B', parentId: 'T100' }),
      makeTask({ id: 'T200', title: 'unrelated', parentId: null }),
      makeTask({ id: 'T201', title: 'other-child', parentId: 'T200' }),
    ];
    const result = await findTasks({ parent: 'T100' }, undefined, mockAccessor(tasks));
    expect(result.results.map((r) => r.id).sort()).toEqual(['T101', 'T102']);
    expect(result.total).toBe(2);
  });

  it('rejects empty-string query when no other filter is supplied', async () => {
    // The empty-string bypass: previously `findTasks({ query: '' })` would
    // run fuzzy-mode and match every task via `fuzzyScore('', t.title) === 80`.
    // Now `''` is normalised to undefined and the no-filter guard fires.
    await expect(findTasks({ query: '' }, undefined, mockAccessor([]))).rejects.toThrow(
      /query.*--id.*filter/i,
    );
  });

  it('rejects whitespace-only query when no other filter is supplied', async () => {
    await expect(findTasks({ query: '   ' }, undefined, mockAccessor([]))).rejects.toThrow(
      /query.*--id.*filter/i,
    );
  });

  it('does NOT bypass the --parent filter when query is empty string', async () => {
    // The exact bug from T10108: `cleo find "" --parent T100` must NOT
    // return the unfiltered global result set.
    const tasks = [
      makeTask({ id: 'T100', title: 'parent', type: 'epic' }),
      makeTask({ id: 'T101', title: 'child', parentId: 'T100' }),
      makeTask({ id: 'T999', title: 'stranger', parentId: null }),
    ];
    const result = await findTasks({ query: '', parent: 'T100' }, undefined, mockAccessor(tasks));
    expect(result.results.map((r) => r.id)).toEqual(['T101']);
    expect(result.total).toBe(1);
  });

  it('composes --parent with --status', async () => {
    const tasks = [
      makeTask({ id: 'T100', title: 'parent', type: 'epic' }),
      makeTask({ id: 'T101', title: 'child A pending', parentId: 'T100', status: 'pending' }),
      makeTask({ id: 'T102', title: 'child B done', parentId: 'T100', status: 'done' }),
      makeTask({ id: 'T103', title: 'child C pending', parentId: 'T100', status: 'pending' }),
    ];
    const result = await findTasks(
      { parent: 'T100', status: 'pending' },
      undefined,
      mockAccessor(tasks),
    );
    expect(result.results.map((r) => r.id).sort()).toEqual(['T101', 'T103']);
  });

  it('composes --parent with a fuzzy query', async () => {
    const tasks = [
      makeTask({ id: 'T100', title: 'parent', type: 'epic' }),
      makeTask({ id: 'T101', title: 'implement auth flow', parentId: 'T100' }),
      makeTask({ id: 'T102', title: 'fix docs', parentId: 'T100' }),
      makeTask({ id: 'T201', title: 'auth in another epic', parentId: 'T200' }),
    ];
    const result = await findTasks(
      { query: 'auth', parent: 'T100' },
      undefined,
      mockAccessor(tasks),
    );
    // Only T101 matches BOTH the fuzzy query AND the parent filter.
    expect(result.results.map((r) => r.id)).toEqual(['T101']);
  });

  it('routes to saga members when --parent targets a saga', async () => {
    // Sagas hold members through task_relations.type='groups', NOT parentId.
    // resolveSagaMemberIds returns the member IDs; findTasks must restrict
    // the result set to that member set even though the rows themselves
    // have parentId=null (top-level Epics).
    const sagaTask = makeTask({
      id: 'SG_T9999',
      title: 'saga root',
      type: 'epic',
      labels: ['saga'],
      relates: [
        { taskId: 'T800', type: 'groups' },
        { taskId: 'T801', type: 'groups' },
      ],
    });
    const tasks: Task[] = [
      sagaTask,
      makeTask({ id: 'T800', title: 'epic A', type: 'epic', parentId: null }),
      makeTask({ id: 'T801', title: 'epic B', type: 'epic', parentId: null }),
      makeTask({ id: 'T802', title: 'epic C — NOT a member', type: 'epic', parentId: null }),
    ];
    const result = await findTasks({ parent: 'SG_T9999' }, undefined, mockAccessor(tasks));
    expect(result.results.map((r) => r.id).sort()).toEqual(['T800', 'T801']);
  });

  it('parity with cleo list --parent: identical id set for the same parent', async () => {
    // Mirrors the AC2 contract: `cleo find <query> --parent <id>` works the
    // same as `cleo list --parent <id>` for the parent filter axis.
    const tasks = [
      makeTask({ id: 'T100', title: 'parent', type: 'epic' }),
      makeTask({ id: 'T101', title: 'child A', parentId: 'T100' }),
      makeTask({ id: 'T102', title: 'child B', parentId: 'T100' }),
      makeTask({ id: 'T103', title: 'child C', parentId: 'T100' }),
      makeTask({ id: 'T999', title: 'not a child', parentId: null }),
    ];
    const findResult = await findTasks({ parent: 'T100' }, undefined, mockAccessor(tasks));
    const findIds = findResult.results.map((r) => r.id).sort();

    // Direct accessor query mirrors what `listTasks` would resolve for
    // parentId='T100' without the Saga branch.
    const listResult = await mockAccessor(tasks).queryTasks({ parentId: 'T100' });
    const listIds = listResult.tasks.map((t) => t.id).sort();

    expect(findIds).toEqual(listIds);
  });
});
