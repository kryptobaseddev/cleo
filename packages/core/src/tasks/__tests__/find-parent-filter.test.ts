/**
 * Tests for the `--parent` filter on `cleo find` (T10108).
 *
 * Closes the T10108 bug class where `cleo find "" --parent T9758` returned
 * the full unfiltered task set (~1216 rows). Two compounding defects were
 * the cause:
 *
 *   1. The CLI `find` command had no `--parent` flag, so the value was
 *      silently dropped before dispatch.
 *   2. The empty-string `""` query short-circuited to fuzzy mode, where
 *      `fuzzyScore('', '<any title>')` returned 80 (substring match of the
 *      empty string), so every row "matched".
 *
 * This file covers the core `findTasks({ parent })` behaviour and the
 * empty-string normalisation that lets the filter compose with no query.
 *
 * @task T10108
 * @saga T9862
 */

import type { Task, TaskQueryFilters } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import type { DataAccessor } from '../../store/data-accessor.js';
import { findTasks } from '../find.js';

/** Build a mock DataAccessor that honours `parentId`, `status`, `label`. */
function mockAccessor(tasks: Task[]): DataAccessor {
  return {
    queryTasks: async (filters: TaskQueryFilters | undefined) => {
      let list = tasks;
      if (filters?.status) list = list.filter((t) => t.status === filters.status);
      if (filters?.label) list = list.filter((t) => (t.labels ?? []).includes(filters.label!));
      if (filters?.parentId !== undefined) {
        list = list.filter((t) => t.parentId === filters.parentId);
      }
      return { tasks: list, total: list.length };
    },
    loadArchive: async () => ({ archivedTasks: [] }),
    loadSingleTask: async (id: string) => tasks.find((t) => t.id === id) ?? null,
  } as unknown as DataAccessor;
}

/** Build a mock accessor that simulates a Saga (`type='saga'`) + member Epics. */
function mockAccessorWithSaga(tasks: Task[], sagaId: string, memberIds: string[]): DataAccessor {
  const tasksWithRelations = tasks.map((t) => {
    if (t.id === sagaId) {
      return {
        ...t,
        type: 'saga' as const,
      } as Task;
    }
    if (memberIds.includes(t.id)) {
      return { ...t, parentId: sagaId } as Task;
    }
    return t;
  });
  return {
    queryTasks: async (filters: TaskQueryFilters | undefined) => {
      let list = tasksWithRelations;
      if (filters?.status) list = list.filter((t) => t.status === filters.status);
      if (filters?.parentId !== undefined) {
        list = list.filter((t) => t.parentId === filters.parentId);
      }
      return { tasks: list, total: list.length };
    },
    loadArchive: async () => ({ archivedTasks: [] }),
    loadSingleTask: async (id: string) => tasksWithRelations.find((t) => t.id === id) ?? null,
  } as unknown as DataAccessor;
}

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    id: overrides.id,
    title: overrides.id,
    description: '',
    status: 'pending',
    priority: 'medium',
    type: 'task',
    size: 'small',
    parentId: null,
    labels: [],
    depends: [],
    acceptance: [],
    createdAt: '2026-05-24T00:00:00Z',
    ...overrides,
  } as Task;
}

describe('findTasks --parent (T10108)', () => {
  it('selects only direct children of the parent', async () => {
    const tasks = [
      makeTask({ id: 'T001', parentId: 'T9758' }),
      makeTask({ id: 'T002', parentId: 'T9758' }),
      makeTask({ id: 'T003', parentId: 'T8000' }),
      makeTask({ id: 'T004', parentId: null }),
    ];
    const result = await findTasks({ parent: 'T9758' }, '/mock', mockAccessor(tasks));
    const ids = result.results.map((r) => r.id).sort();
    expect(ids).toEqual(['T001', 'T002']);
  });

  it('returns empty when no task matches the parent', async () => {
    const tasks = [
      makeTask({ id: 'T001', parentId: 'T9758' }),
      makeTask({ id: 'T002', parentId: null }),
    ];
    const result = await findTasks({ parent: 'T9999' }, '/mock', mockAccessor(tasks));
    expect(result.results).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('composes parent with status filter (AND)', async () => {
    const tasks = [
      makeTask({ id: 'T001', parentId: 'T9758', status: 'pending' }),
      makeTask({ id: 'T002', parentId: 'T9758', status: 'done' }),
      makeTask({ id: 'T003', parentId: 'T8000', status: 'pending' }),
    ];
    const result = await findTasks(
      { parent: 'T9758', status: 'pending' },
      '/mock',
      mockAccessor(tasks),
    );
    expect(result.results.map((r) => r.id)).toEqual(['T001']);
  });

  it('composes parent with label filter (AND)', async () => {
    const tasks = [
      makeTask({ id: 'T001', parentId: 'T9758', labels: ['bug'] }),
      makeTask({ id: 'T002', parentId: 'T9758', labels: ['feature'] }),
      makeTask({ id: 'T003', parentId: 'T8000', labels: ['bug'] }),
    ];
    const result = await findTasks({ parent: 'T9758', label: 'bug' }, '/mock', mockAccessor(tasks));
    expect(result.results.map((r) => r.id)).toEqual(['T001']);
  });

  it('parent filter alone (no query, no id) is valid filter-only mode', async () => {
    const tasks = [makeTask({ id: 'T001', parentId: 'T9758' })];
    // Should NOT throw "query or --id required"
    const result = await findTasks({ parent: 'T9758' }, '/mock', mockAccessor(tasks));
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.id).toBe('T001');
  });

  it('empty-string query with --parent does NOT bypass filter (T10108 regression)', async () => {
    const tasks = [
      makeTask({ id: 'T001', parentId: 'T9758' }),
      makeTask({ id: 'T002', parentId: 'T8000' }),
      makeTask({ id: 'T003', parentId: null }),
    ];
    // Empty-string query MUST be treated as "no query" so the parent filter still applies.
    // Pre-T10108: every task matched via fuzzyScore('', '<title>')===80, returning all 3.
    const result = await findTasks({ query: '', parent: 'T9758' }, '/mock', mockAccessor(tasks));
    expect(result.results.map((r) => r.id)).toEqual(['T001']);
  });

  it('whitespace-only query is treated as no query', async () => {
    const tasks = [
      makeTask({ id: 'T001', parentId: 'T9758' }),
      makeTask({ id: 'T002', parentId: 'T8000' }),
    ];
    const result = await findTasks({ query: '   ', parent: 'T9758' }, '/mock', mockAccessor(tasks));
    expect(result.results.map((r) => r.id)).toEqual(['T001']);
  });

  it('routes Saga parents through parentId containment (ADR-073 §1)', async () => {
    const tasks = [
      makeTask({ id: 'T9758', parentId: null, type: 'saga' }),
      makeTask({ id: 'EPIC001', parentId: null, type: 'epic' }), // member epic
      makeTask({ id: 'EPIC002', parentId: null, type: 'epic' }), // member epic
      makeTask({ id: 'EPIC003', parentId: null, type: 'epic' }), // NOT a member
    ];
    const result = await findTasks(
      { parent: 'T9758' },
      '/mock',
      mockAccessorWithSaga(tasks, 'T9758', ['EPIC001', 'EPIC002']),
    );
    const ids = result.results.map((r) => r.id).sort();
    expect(ids).toEqual(['EPIC001', 'EPIC002']);
  });
});
